import { eq } from "drizzle-orm";
import { config, parseHhmm } from "../config";
import { db } from "../db/client";
import { runs, schedules, users, type Run } from "../db/schema";
import { logger } from "../lib/logger";
import { isUniqueViolation } from "../lib/pg-errors";
import { isPausedOn, manilaDateString } from "../lib/ph-holidays";
import type { ClockAction } from "../automation/clock";
import { resolveHolidayDecision } from "./holidays";
import { dispatch } from "./notifications";
import { runQueue } from "./run-queue";
import {
  cancelPendingRetry,
  hasPendingRetry,
  manilaWallTime,
  scheduleOneShotRetry,
} from "./retry-registry";

// Phase 14 — retry a run that failed on a TRANSIENT failure (HRHub being down,
// an OTP that never arrived, a portal that 500s after login). NEVER retries a
// `skipped` run (that would risk a double-clock). The scheduling arithmetic is
// pure and injectable (nextAttempt), so it is unit-tested with an injected
// clock — no Date.now() inside the schedulable logic (BACKLOG §11).

export type RetryPolicy = {
  intervalMinutes: number;
  maxAttempts: number;
  cutoffClockIn: string; // Manila HH:mm
  cutoffClockOut: string; // Manila HH:mm
};

export function currentPolicy(): RetryPolicy {
  return {
    intervalMinutes: config.RETRY_INTERVAL_MINUTES,
    maxAttempts: config.RETRY_MAX_ATTEMPTS,
    cutoffClockIn: config.RETRY_CLOCKIN_CUTOFF,
    cutoffClockOut: config.RETRY_CLOCKOUT_CUTOFF,
  };
}

/** True when an instant's Manila wall-clock time is past the HH:mm cutoff. */
export function pastCutoff(dt: Date, cutoffHhmm: string): boolean {
  const { hour: ch, minute: cm } = parseHhmm(cutoffHhmm);
  const cutoffMin = ch * 60 + cm;
  const wall = manilaWallTime(dt);
  const hour = Number(wall.slice(0, 2));
  const minute = Number(wall.slice(3, 5));
  return hour * 60 + minute > cutoffMin;
}

/**
 * The next retry attempt time after `failedAt`, or null when no further attempt
 * is allowed. Two independent brakes, both enforced:
 *   - the attempt cap (a retry is attempt+1, which must be <= maxAttempts), and
 *   - the wall-clock cutoff, which stops a retry past its action's cutoff even
 *     when attempts remain (a mistuned interval cannot walk into the afternoon).
 */
export function nextAttempt(
  failedAt: Date,
  action: ClockAction,
  attempt: number,
  policy: RetryPolicy,
): Date | null {
  if (attempt >= policy.maxAttempts) return null;
  const next = new Date(failedAt.getTime() + policy.intervalMinutes * 60_000);
  const cutoff = action === "in" ? policy.cutoffClockIn : policy.cutoffClockOut;
  if (pastCutoff(next, cutoff)) return null;
  return next;
}

// --- Message rendering (pure) -------------------------------------------------

const timeFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Manila",
  hour: "2-digit",
  minute: "2-digit",
});

export function renderRetryScheduledMessage(
  action: ClockAction,
  nextAt: Date,
  showDefault: boolean,
): string {
  const label = action === "in" ? "Clock-in" : "Clock-out";
  const time = timeFmt.format(nextAt);
  const verb = action === "in" ? "in" : "out";
  let msg = `🔁 <b>${label} failed — will retry</b>\nNext attempt at ${time} Manila time.`;
  if (showDefault) {
    msg +=
      `\n\nRetrying every ${config.RETRY_INTERVAL_MINUTES} minutes ` +
      `(up to ${config.RETRY_MAX_ATTEMPTS} attempts), unless you clock ` +
      `${verb} manually.`;
  }
  return msg;
}

export function renderRetryGiveUpMessage(
  action: ClockAction,
  attempts: number,
): string {
  const label = action === "in" ? "Clock-in" : "Clock-out";
  const verb = action === "in" ? "in" : "out";
  return (
    `🛑 <b>${label} failed ${attempts} ${attempts === 1 ? "time" : "times"} ` +
    `and gave up</b>\nPlease clock ${verb} manually in HRHub.`
  );
}

// --- Dispatch (fire-and-forget; a dead Telegram endpoint never affects a run) --

async function sendScheduled(
  userId: string,
  action: ClockAction,
  nextAt: Date,
): Promise<void> {
  try {
    // "Say the default exactly once": the first retry scheduled for a user who
    // has never seen the explanation mentions the default; afterwards, silent.
    const [u] = await db
      .select({ shown: users.retryIntroShown })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const showDefault = !(u?.shown);
    if (showDefault) {
      await db
        .update(users)
        .set({ retryIntroShown: true })
        .where(eq(users.id, userId));
    }
    await dispatch(
      userId,
      renderRetryScheduledMessage(action, nextAt, showDefault),
      "retry",
    );
  } catch (err: unknown) {
    logger.error({ userId, action, err }, "retry-scheduled notification failed");
  }
}

async function sendGiveUp(
  userId: string,
  action: ClockAction,
  attempts: number,
): Promise<void> {
  try {
    await dispatch(
      userId,
      renderRetryGiveUpMessage(action, attempts),
      "retry",
    );
  } catch (err: unknown) {
    logger.error({ userId, action, err }, "retry give-up notification failed");
  }
}

// --- Attempt execution ---------------------------------------------------------

/**
 * Fired when a pending one-shot retry's time arrives. Re-checks EVERY gate the
 * scheduler itself respects (holiday, pause, day rollover) — a pause set at
 * 07:00 cancels a retry queued at 05:30 — then inserts the retry run through
 * the partial-unique-index gate. Let Postgres arbitrate: a 23505 (a run is
 * already active for this user — e.g. a manual run started) is treated as
 * already-handled and the retry is cancelled, never a 500.
 */
export async function attemptRun(
  userId: string,
  action: ClockAction,
  manilaDate: string,
  attempt: number,
): Promise<void> {
  try {
    const now = new Date();
    const decision = await resolveHolidayDecision(now);
    if (decision.skip) {
      cancelPendingRetry(userId, action, manilaDate);
      return;
    }
    const [schedule] = await db
      .select()
      .from(schedules)
      .where(eq(schedules.userId, userId))
      .limit(1);
    if (schedule && isPausedOn(schedule, now)) {
      cancelPendingRetry(userId, action, manilaDate);
      return;
    }
    // Day rolled over: a retry must never fire for yesterday.
    if (manilaDateString(now) !== manilaDate) {
      cancelPendingRetry(userId, action, manilaDate);
      return;
    }

    try {
      const [run] = await db
        .insert(runs)
        .values({ userId, action, status: "pending", attempt })
        .returning();
      if (!run) throw new Error("retry insert returned no row");
      runQueue.enqueue({ runId: run.id });
      logger.info(
        { runId: run.id, userId, action, attempt, manilaDate },
        "retry run enqueued",
      );
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        // A run is already active for this user — the retry is superseded.
        cancelPendingRetry(userId, action, manilaDate);
        return;
      }
      throw err;
    }
    cancelPendingRetry(userId, action, manilaDate);
  } catch (err: unknown) {
    logger.error({ userId, action, attempt, err }, "retry attempt failed");
  }
}

// --- Orchestrator (called when a run reaches `failure`) ------------------------

/**
 * Decide whether a just-failed run should be retried and, if so, schedule the
 * next one-shot attempt. Never throws across the caller's fire-and-forget
 * boundary. Never retries a `skipped` run (the hard constraint).
 *
 * The interval is measured from the failure instant — the run's `finishedAt`,
 * or an injected `now` (tests). A production failure at 05:35 schedules the
 * 06:05 attempt; the wall-clock cutoff then correctly refuses an afternoon
 * retry even before the cap is reached.
 *
 * Returns the outcome so the caller can decide the notification:
 *   - "retry":   a retry is pending (a "retrying at HH:MM" message was sent on
 *                the first failure). The caller suppresses the standard failure
 *                ⚠️ — the retry message REPLACES it (14B: one bad morning must
 *                not produce one ⚠️ per attempt).
 *   - "give-up": the sequence ended without success (a give-up message was
 *                sent). The caller suppresses the ⚠️ — the give-up is the
 *                resolution message.
 *   - "none":    nothing was scheduled or sent. The caller keeps the ⚠️.
 *
 * The messages are fired fire-and-forget (`void send…`): a dead Telegram
 * endpoint must never change the run's status, timing, or the HTTP response
 * (hard rule 11), so the decision path itself touches no network.
 */
export async function scheduleRetryOnFailure(
  run: Run,
  now: Date | null = null,
): Promise<"retry" | "give-up" | "none"> {
  if (run.status !== "failure") return "none";
  const anchor = now ?? run.finishedAt ?? run.startedAt ?? new Date();
  const policy = currentPolicy();
  const manilaDate = manilaDateString(run.startedAt);

  // If a retry is already pending for this user/action/day, don't stack a
  // second one — the DB partial-unique gate and this guard both prevent it.
  // The pending retry covers this failure, so the ⚠️ is suppressed.
  if (hasPendingRetry(run.userId, run.action, manilaDate)) return "retry";

  const next = nextAttempt(anchor, run.action, run.attempt, policy);
  if (next === null) {
    // No further attempt is allowed (cap reached or past cutoff). If a retry
    // sequence had begun, tell the user it gave up — one message.
    if (run.attempt >= 1) {
      void sendGiveUp(run.userId, run.action, run.attempt);
      return "give-up";
    }
    return "none";
  }

  const attempt = run.attempt + 1;
  scheduleOneShotRetry({
    userId: run.userId,
    action: run.action,
    manilaDate,
    attempt,
    fireAt: next,
    onFire: () => {
      void attemptRun(run.userId, run.action, manilaDate, attempt);
    },
  });

  if (run.attempt === 0) {
    void sendScheduled(run.userId, run.action, next);
  }
  return "retry";
}
