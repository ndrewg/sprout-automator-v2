import { eq, inArray } from "drizzle-orm";
import { db } from "../db/client";
import { credentials, runs, type Run } from "../db/schema";
import { logger } from "../lib/logger";
import { pingHeartbeat } from "../lib/heartbeat";
import { manilaDateString, decideDay, type DayDecision, type WorkdayReasonCode } from "./workday";
import { isUniqueViolation } from "../lib/pg-errors";
import { errorSummary, stripAnsi } from "../lib/text";
import { shouldScheduleRetry, type StoredOutcome } from "../lib/run-outcome";
import { onTick } from "../lib/wall-clock-tick";
import type { ClockAction } from "../automation/clock";
import { notifyHeadsUp, notifyRunFinished } from "./notifications";
import {
  currentPolicy,
  cutoffFor,
  notifyRetryGiveUp,
  pastCutoff,
  scheduleRetryOnFailure,
} from "./retry";
import {
  cancelAllPendingRetries,
  claimRetry,
  clearPendingRetry,
  loadDueRetries,
} from "./retry-state";
import { runQueue } from "./run-queue";

// The Run lifecycle (phase 15A, D20) — the ONE module every run transition
// goes through. Run state used to be spread across seven modules with two ways
// to create a run (`startRun`, the retry path's own INSERT) and three writers
// of a final status (`finalizeRun`, `failRunFromExecutor`, `recoverOrphanedRuns`),
// two of which skipped the retry decision and the notification. Every silent
// path in the 2026-10-14 review traced back to that shape.
//
// The contract:
//
//   EVERY TRIGGER creates a run here, through `startRun` — the scheduled slot,
//   the due retry, and the manual "Clock in now" click. One insert, one
//   credentials check, one `23505` → "already running" mapping, one place that
//   supersedes a queued retry.
//
//   EVERY ENDING goes through `finishRun` — a normal result, the executor
//   backstop, and orphan recovery at boot. It records the status, makes the
//   retry decision, picks the message and pings the heartbeat.
//
//   THE INVARIANT: "a run row exists for this slot" means "this slot was
//   handled". The scheduler's re-fire check and the missed-run sweep both rely
//   on it, and it only holds while every terminal write is in here.
//
// What deliberately does NOT live here: rendering and sending messages
// (services/notifications.ts), the retry policy and messages
// (services/retry.ts), the pending-retry storage (services/retry-state.ts), and
// the queue itself (services/run-queue.ts — an in-memory Chromium cap, D6,
// unchanged).

export type RunOutcome = "success" | "skipped" | "failure";

export type StartRunParams = {
  userId: string;
  action: ClockAction;
  /** The attempt number: 0 for the original run, 1…N for retries. */
  attempt?: number;
  /**
   * The Manila day whose queued retry this run supersedes. The scheduler passes
   * its tick's instant; a manual click and a due retry use their own. Defaults
   * to the wall clock's Manila day.
   */
  manilaDate?: string;
};

export type StartRunResult =
  | { ok: true; run: Run }
  | { ok: false; reason: "no_credentials" | "already_running" };

/**
 * The lifecycle's collaborators. Injected so the tests can drive the module's
 * interface — "trigger in, status/retry state/messages out" — without a
 * Chromium and without a Telegram endpoint. Production uses the defaults.
 */
export type LifecycleDeps = {
  /** Hand a freshly created run to the queue, whose executor runs it. */
  enqueue: (job: { runId: string }) => void;
  /** The terminal-outcome message (rendered and sent in notifications.ts). */
  notifyRunFinished: typeof notifyRunFinished;
  /**
   * The evening heads-up (phase 16D), sent once after a clock-out run reaches
   * an outcome. Fire-and-forget (hard rule 11).
   */
  notifyHeadsUp: typeof notifyHeadsUp;
  /** The dead-man's-switch ping. Fire-and-forget (hard rule 11). */
  pingHeartbeat: () => void;
};

export const defaultLifecycleDeps: LifecycleDeps = {
  enqueue: (job) => runQueue.enqueue(job),
  notifyRunFinished,
  notifyHeadsUp,
  pingHeartbeat,
};

function withDeps(overrides: Partial<LifecycleDeps>): LifecycleDeps {
  return { ...defaultLifecycleDeps, ...overrides };
}

// --- Creation (the one and only path) -----------------------------------------

/**
 * Create a run for ANY trigger and hand it to the queue.
 *
 * Insert as `pending` and let the partial unique index gate concurrency.
 * NEVER pre-check with a SELECT — the DB index is the race guard (D6), and a
 * `23505` means a run is already active for this user, which is reported as
 * `already_running` rather than thrown as a 500.
 *
 * Starting a run for an action also supersedes that action's queued retry: a
 * manual "Clock in now" and the next scheduled fire are both explicit
 * statements that replace it (phase 14 cancellation, now durable).
 */
export async function startRun(
  params: StartRunParams,
  deps: Partial<LifecycleDeps> = {},
): Promise<StartRunResult> {
  const { userId, action } = params;
  const d = withDeps(deps);

  const [cred] = await db
    .select()
    .from(credentials)
    .where(eq(credentials.userId, userId))
    .limit(1);
  if (!cred || !cred.sproutUsernameEnc || !cred.sproutPasswordEnc) {
    return { ok: false, reason: "no_credentials" };
  }

  try {
    const [run] = await db
      .insert(runs)
      .values({ userId, action, status: "pending", attempt: params.attempt ?? 0 })
      .returning();
    if (!run) throw new Error("startRun: insert returned no row");
    d.enqueue({ runId: run.id });
    await clearPendingRetry(
      userId,
      action,
      params.manilaDate ?? manilaDateString(new Date()),
    );
    logger.info({ runId: run.id, userId, action, attempt: run.attempt }, "run enqueued");
    return { ok: true, run };
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      return { ok: false, reason: "already_running" };
    }
    throw err;
  }
}

// --- The terminal step ---------------------------------------------------------

export type FinishRunParams = {
  run: Run;
  status: RunOutcome;
  /**
   * The machine-readable outcome, when the status alone is not enough
   * (phase 17, D20). Only "unknown" exists today: the click was dispatched,
   * HRHub did not confirm it and its own attendance card does not show the row
   * either. Stored as `status = 'failure'` + `outcome = 'unknown'`, and the one
   * thing that changes the retry decision.
   */
  outcome?: StoredOutcome | null;
  loginMethod?: string | null;
  error?: string | null;
  /** For the notifier only — never persisted (runs has no such column). */
  skipReason?: string | null;
};

export type FinishRunResult = {
  status: RunOutcome;
  /** What the retry decision did. "none" = this was not a failure. */
  retry: "retry" | "give-up" | "none";
  /** Whether an outcome message was handed to the notifier. */
  notified: boolean;
  /** Whether the dead-man's-switch heartbeat was pinged. */
  pinged: boolean;
};

/**
 * The ONE writer of a final run status. Records the status, makes the retry
 * decision, sends exactly one outcome message and pings the heartbeat.
 *
 * Notification discipline (14B, unchanged): a failure that queues a retry, or
 * that ends the sequence with a give-up, does NOT also send the standard
 * failure ⚠️ — the retry/give-up message replaces it, so one bad morning
 * produces the scheduling message, silence, and one resolution message rather
 * than one message per attempt.
 *
 * Heartbeat (15A): the ping moved here from the fire path, so an outside
 * monitor means "today's slot reached an outcome" rather than "the tick ran".
 * It fires on success, on a deliberate skip (already clocked) and on a
 * terminal failure — never while a retry is still queued, because that slot has
 * not reached its outcome yet.
 *
 * "Unknown" (phase 17, D20): a failure that could not confirm whether the click
 * landed carries `outcome: "unknown"`, which suppresses the retry entirely.
 * It is still notified — the retry path's replacement rule does not apply
 * because there is no retry message to replace it with — and it still pings,
 * because the slot HAS reached its outcome.
 */
export async function finishRun(
  params: FinishRunParams,
  opts: { now?: Date | null; deps?: Partial<LifecycleDeps> } = {},
): Promise<FinishRunResult> {
  const d = withDeps(opts.deps ?? {});
  // The error is stripped of ANSI escapes before it is persisted, so the
  // RunsPanel, the logs and the notification all see clean text (defect 3).
  const error = params.error == null ? null : stripAnsi(params.error);

  const patch: Partial<typeof runs.$inferInsert> = {
    status: params.status,
    outcome: params.outcome ?? null,
    error,
    finishedAt: new Date(),
  };
  if (params.loginMethod !== undefined) patch.loginMethod = params.loginMethod;

  const [updated] = await db
    .update(runs)
    .set(patch)
    .where(eq(runs.id, params.run.id))
    .returning();
  if (!updated) throw new Error("finishRun: update returned no row");
  logger.info(
    { runId: updated.id, status: params.status, outcome: updated.outcome },
    "run finished",
  );

  // The retry decision, tightened by phase 17: `failure` only, never a skip,
  // and NEVER an `unknown` failure — a retry against a day whose state we could
  // not confirm is a second clock, which is the outcome this whole phase exists
  // to prevent. The rule lives in lib/run-outcome.ts so it is testable without
  // a database.
  const retry = shouldScheduleRetry(params.status, params.outcome ?? null)
    ? await scheduleRetryOnFailure(updated, opts.now ?? null)
    : "none";

  const notified = params.status !== "failure" || retry === "none";
  if (notified) {
    // Fire-and-forget (sanctioned idiom #2, §03). A notification must never
    // change run status or timing; notifyRunFinished never throws, and the
    // .catch is belt-and-braces so a future refactor cannot make this crash a run.
    void d.notifyRunFinished({
      run: updated,
      skipReason: params.skipReason ?? null,
    }).catch(() => {}); // oxlint-disable-line promise/prefer-await-to-then -- sanctioned fire-and-forget idiom (#2), §03.
  }

  // Reaching an outcome = anything but a failure that will be retried (15A).
  const pinged = params.status !== "failure" || retry !== "retry";

  // The evening heads-up (phase 16D): ONE message about the next workday's
  // decision, after a CLOCK-OUT run reaches an outcome — any status. A failure
  // with a retry queued has NOT reached its outcome, so the heads-up waits for
  // the retry chain to end (found in a sandbox run 2026-10-15: it used to go out
  // beside "Clock-out failed — will retry"). A run that never happened (missed,
  // or a skip with no run row) sends nothing; the missed-run alert covers that
  // day. Once per user per Manila day, recorded in the database, and
  // fire-and-forget so a dead Telegram endpoint can never change the run's
  // status or timing (hard rule 11).
  if (updated.action === "out" && pinged) {
    void d
      .notifyHeadsUp({ userId: updated.userId, now: opts.now ?? new Date() })
      .catch(() => {}); // oxlint-disable-line promise/prefer-await-to-then -- sanctioned fire-and-forget idiom (#2), §03.
  }

  if (pinged) d.pingHeartbeat();

  return { status: params.status, retry, notified, pinged };
}

/**
 * The queue's failure handler (backlog #2). A run executor that rejects despite
 * `executeQueuedRun`'s own try/catch must not leave a run pending: it is ended
 * through the same terminal step as everything else, so it is notified and
 * retried like any other failure (path 4 of the phase-15 review).
 *
 * Registered by the startup path (`index.ts`) with `runQueue.setFailureHandler`
 * — injected rather than imported so run-queue.ts and this module do not form an
 * import cycle (the queue needs a terminal writer; the lifecycle needs the queue).
 */
export async function failRunFromExecutor(
  runId: string,
  err: unknown,
  opts: { now?: Date | null; deps?: Partial<LifecycleDeps> } = {},
): Promise<void> {
  try {
    const [run] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);
    if (!run) {
      logger.error({ runId, err }, "run executor rejected for a missing run");
      return;
    }
    // A terminal status means executeQueuedRun already handled the failure —
    // only a run still pending/running was left unhandled by the rejection.
    if (run.status !== "pending" && run.status !== "running") return;
    logger.error({ runId, err }, "run executor rejected — ending the run as a failure");
    await finishRun(
      { run, status: "failure", error: errorSummary(err) },
      { now: opts.now ?? null, deps: opts.deps },
    );
  } catch (err2: unknown) {
    logger.error({ runId, err: err2 }, "failRunFromExecutor failed");
  }
}

/**
 * Boot-time orphan recovery (path 1). A run left `pending`/`running` by a
 * previous process is ended through the terminal step — NOT written directly —
 * so the user is notified and a retry is queued when one is still possible.
 * The error text stays "Interrupted by server restart".
 *
 * Retrying an interrupted run is safe: the already-clocked guard reads HRHub
 * before it clicks, and phase 17 hardens that guard.
 */
export async function recoverOrphanedRuns(
  opts: { now?: Date | null; deps?: Partial<LifecycleDeps> } = {},
): Promise<number> {
  const orphans = await db
    .select()
    .from(runs)
    .where(inArray(runs.status, ["pending", "running"]));
  let recovered = 0;
  for (const run of orphans) {
    await finishRun(
      { run, status: "failure", error: "Interrupted by server restart" },
      { now: opts.now ?? null, deps: opts.deps },
    );
    recovered += 1;
  }
  return recovered;
}

// --- The retry trigger (the third way a run is created) ------------------------

export type RetryFireDeps = LifecycleDeps & {
  /** The creation step a due retry goes through. Injectable so a test can make it fail. */
  createRun: (params: StartRunParams) => Promise<StartRunResult>;
  /**
   * The Workday gate (phase 16A). One call answers "should this user be clocked
   * on this Manila day?" — holiday, pause window, weekend and the user's own day
   * override included — replacing the separate holiday layer and pause probe
   * this module used to run.
   */
  decideDay: (params: {
    userId: string;
    manilaDate: string;
    now?: Date;
  }) => Promise<DayDecision>;
};

export const defaultRetryFireDeps: RetryFireDeps = {
  ...defaultLifecycleDeps,
  createRun: (params) => startRun(params),
  decideDay,
};

/**
 * Fire every retry whose `retry_at` has arrived. Driven by the shared
 * wall-clock tick, so a late tick only delays a retry by seconds.
 *
 * Reads the DATABASE, not a Map (15B): a retry queued before a restart is still
 * there afterwards. Each one is CLAIMED first (a single atomic UPDATE that
 * nulls `retry_at`), so two ticks — or a restarted process racing the old one —
 * can never fire it twice.
 */
export async function fireDueRetries(
  now: Date,
  deps: Partial<RetryFireDeps> = {},
): Promise<void> {
  const d: RetryFireDeps = { ...defaultRetryFireDeps, ...deps };

  let due: Run[];
  try {
    due = await loadDueRetries(now);
  } catch (err: unknown) {
    logger.error({ err }, "loading due retries failed");
    return;
  }

  for (const row of due) {
    let claimed: Run | undefined;
    try {
      claimed = await claimRetry(row.id);
    } catch (err: unknown) {
      logger.error({ runId: row.id, err }, "claiming a due retry failed");
      continue;
    }
    if (!claimed) continue; // another tick (or a racing restart) claimed it
    try {
      await fireClaimedRetry(claimed, now, d);
    } catch (err: unknown) {
      // The row was claimed before this ran, so `retry_at` is already null: a
      // failed retry attempt can NOT stay "pending" and suppress the day's
      // missed-run alert (path 3 of the review).
      logger.error({ runId: claimed.id, err }, "retry attempt failed");
    }
  }
}

/**
 * Fire ONE claimed retry, re-applying every guard the scheduler respects —
 * including after a restart: the attempt cap, the wall-clock cutoff, the
 * holiday layer and the pause window. A retry that no longer deserves to run is
 * discarded with a give-up message; it never puts a late clock on the record.
 */
async function fireClaimedRetry(
  run: Run,
  now: Date,
  d: RetryFireDeps,
): Promise<void> {
  const policy = currentPolicy();
  const manilaDate = manilaDateString(run.startedAt);
  const action = run.action;

  // Day rollover: this retry belongs to another Manila day. Discard it and say
  // so — the "will retry at HH:MM" message already promised an attempt, and
  // silence is the thing this phase exists to remove. Fire-and-forget: a dead
  // Telegram endpoint must never block the tick for other users (rule 11).
  if (manilaDateString(now) !== manilaDate) {
    logger.info(
      { runId: run.id, action, manilaDate },
      "retry discarded — the failed run belongs to another Manila day",
    );
    void notifyRetryGiveUp(run);
    return;
  }

  // The attempt cap, re-checked at fire time (a restored retry may have been
  // queued under a different config).
  if (run.attempt >= policy.maxAttempts) {
    logger.info(
      { runId: run.id, action, attempt: run.attempt },
      "retry discarded — the attempt cap is reached",
    );
    void notifyRetryGiveUp(run);
    return;
  }

  // The wall-clock cutoff, re-checked at fire time. A retry restored from
  // before a restart must NEVER fire a 14:00 clock-in.
  if (pastCutoff(now, cutoffFor(action, policy))) {
    logger.info(
      { runId: run.id, action },
      "retry discarded — past the wall-clock cutoff",
    );
    void notifyRetryGiveUp(run);
    return;
  }

  // The Workday gate (phase 16A): a holiday, a pause window set after the retry
  // was queued, or the user's own skip day is a deliberate no-run. The day's
  // skip notice (when there is one) already explains it, so nothing more is
  // sent here — but the slot HAS reached an outcome, so the heartbeat pings.
  const decision = await d.decideDay({ userId: run.userId, manilaDate, now });
  if (!decision.work) {
    logger.info(
      { runId: run.id, action, reason: decision.reason.code },
      "retry cancelled — the workday gate says today is not a work day",
    );
    d.pingHeartbeat();
    return;
  }

  const result = await d.createRun({
    userId: run.userId,
    action,
    attempt: run.attempt + 1,
    manilaDate,
  });
  if (result.ok) {
    logger.info(
      { runId: result.run.id, userId: run.userId, action, attempt: result.run.attempt },
      "retry run enqueued",
    );
    return;
  }
  // A run is already active for this user (a manual click beat us), or the
  // credentials have gone. Either way the retry is superseded — never a 500 —
  // but the two reasons resolve themselves very differently, so they cannot
  // share one silent log line.
  if (result.reason === "no_credentials") {
    // The user was promised an attempt ("will retry at HH:MM") and the
    // credentials then vanished. Nothing will run, and no other message covers
    // this day — the day's failed run row keeps the missed-run sweep quiet — so
    // silence here is exactly the silent path this phase exists to remove.
    logger.info(
      { runId: run.id, userId: run.userId, action, reason: result.reason },
      "retry run not created — credentials are missing",
    );
    void notifyRetryGiveUp(run);
    return;
  }
  // already_running: a run is active for this user (a manual click beat us).
  // That run sends its own outcome message, so this path stays silent.
  logger.info(
    { runId: run.id, userId: run.userId, action, reason: result.reason },
    "retry run not created",
  );
}

/** Register the retry trigger on the shared wall-clock tick. Called by the scheduler. */
export function registerRetryTick(): void {
  onTick("retries", fireDueRetries);
}

// --- Account deletion ----------------------------------------------------------

/**
 * Cancel every queued retry for a user. Account deletion calls this: the
 * cascade would take the rows anyway, but nothing may fire against an account
 * on its way out.
 */
export async function cancelPendingRetriesForUser(userId: string): Promise<number> {
  const cancelled = await cancelAllPendingRetries(userId);
  logger.info({ userId, cancelled }, "cancelled pending retries for user");
  return cancelled;
}

/**
 * Cancel every queued retry for a user on one Manila day. Phase 16B calls this
 * when a day override is set or cleared for TODAY and the new decision is
 * "skip": the user has just said "do not clock me today", so a retry the
 * scheduler already promised must not fire against it.
 */
export async function cancelPendingRetriesForDay(
  userId: string,
  manilaDate: string,
): Promise<number> {
  const cancelledIn = await clearPendingRetry(userId, "in", manilaDate);
  const cancelledOut = await clearPendingRetry(userId, "out", manilaDate);
  const cancelled = cancelledIn + cancelledOut;
  if (cancelled > 0) {
    logger.info(
      { userId, manilaDate, cancelled },
      "cancelled pending retries for the day",
    );
  }
  return cancelled;
}

// --- Deliberate no-run outcomes ------------------------------------------------

/**
 * A slot the scheduler deliberately did not run (a holiday, a pause window, or
 * the user's own skip day). There is no run row, so no `finishRun` — but the
 * slot reached an outcome, which is what the heartbeat means.
 */
export function noteDeliberateSkip(reason: WorkdayReasonCode): void {
  logger.debug({ reason }, "scheduled slot deliberately skipped");
  pingHeartbeat();
}
