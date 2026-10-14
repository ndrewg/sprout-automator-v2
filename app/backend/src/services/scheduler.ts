import { and, eq, gte } from "drizzle-orm";
import { config, schedulerEnabled } from "../config";
import { db } from "../db/client";
import { runs, schedules, type Schedule } from "../db/schema";
import { logger } from "../lib/logger";
import { onTick, TICK_MS } from "../lib/wall-clock-tick";
import { noteDeliberateSkip, registerRetryTick, startRun } from "./run-lifecycle";
import { notifySkip, sweepMissedRuns } from "./notifications";
import { decideDay, expectedFireTime, manilaDateString } from "./workday";
import type { ClockAction } from "../automation/clock";

// The per-user daily scheduler (D8, reworked 2026-10-13, tightened 2026-10-14,
// repointed at the Workday gate 2026-10-14 in phase 16A).
//
// No timers per schedule. Registered schedules live in `active`; the shared
// wall-clock tick (lib/wall-clock-tick.ts, every 15 s) asks dueSlots() which
// Manila slots have arrived and fires each ONCE per day. It replaced
// two node-cron tasks per user: node-cron slept on one long setTimeout per
// slot, and on the scheduled host the monotonic clock drifts so far from the
// wall clock (up to ~450 s/day measured) that the 05:30 slot woke 27 min late
// and was dropped. Comparing against the wall clock on a short tick means a
// late tick delays a run by seconds and never skips it.
//
// Phase 15C: the in-memory `fired` entry is a RE-ENTRANCY GUARD, not the
// record. A slot counts as fired only once a run row (or a deliberate skip)
// exists; anything that fails before that is retried on the next tick until the
// slot's window closes.
//
// Phase 16A: the holiday/pause/weekend/override decision is NOT made here any
// more. `fireCron` asks the Workday gate (`services/workday.ts`) one question —
// "should this user be clocked on this Manila day, and why?" — and acts on the
// answer. The Manila clock helpers come from the gate too: this module no
// longer imports slot arithmetic from the notifications module.

// userId -> the registered (enabled) schedule row. Module-global on purpose:
// one scheduler per process.
const active = new Map<string, Schedule>();

// "userId::action::manilaDate" keys already handled today. Pruned to today on
// every tick. In-memory, so a restart forgets it — fireDueSlot's DB check is
// what stops a restarted process firing a slot twice.
const fired = new Set<string>();

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let lastSweepBucket: number | null = null;

// Timestamp (ISO) of the last scheduled fire attempt, any user, any action.
// Updated at the top of fireCron regardless of whether the fire then enqueued a
// run, skipped a holiday, or was paused. Exposed to /health. NULL until the
// first fire (see 12A).
let lastFireAt: string | null = null;

export function schedulerLastFireAt(): string | null {
  return lastFireAt;
}

/** Count of enabled schedules in the database (what SHOULD be registered). */
export async function enabledScheduleCount(): Promise<number> {
  const rows = await db
    .select()
    .from(schedules)
    .where(eq(schedules.enabled, true));
  return rows.length;
}

/**
 * How long after its slot a run may still start. Equal to the missed-run grace
 * window on purpose: past it, the sweep has already alerted the slot as missed,
 * so firing then would contradict the alert. A late wake is ALERT ONLY (15C):
 * the fire window stays where it is and a host that comes up after it does not
 * clock in late, because the operator pauses by powering the machine off — a
 * late automatic clock-in would put a false record on a day off.
 */
function fireWindowMs(): number {
  return config.MISSED_RUN_GRACE_MINUTES * 60 * 1000;
}

const slotKey = (userId: string, action: ClockAction, manilaDate: string) =>
  `${userId}::${action}::${manilaDate}`;

export type DueSlot = {
  userId: string;
  action: ClockAction;
  manilaDate: string;
  slot: Date;
};

/**
 * Pure: the slots due at `now`, on ANY Manila day, by wall-clock timing alone.
 * A slot is due from its wall time up to `windowMs` after it, unless already
 * fired. The work/non-work decision is NOT made here: `fireCron` asks the
 * Workday gate at fire time, so holidays, WEEKENDS, the user's day overrides and
 * pause windows ALL take effect without re-registering anything — including a
 * "work anyway" override that turns a weekend or holiday into a clock-in.
 *
 * This deliberately no longer filters weekends (phase 16 review, defect B1).
 * Filtering them here meant the scheduler never asked the gate on a Saturday,
 * so a weekend override clocked nobody in — while the missed-run sweep, which
 * DID ask the gate, saw a work day with no run and sent a false alert. Both now
 * consult the one gate. A plain weekend is still silent: the gate says
 * non-work, and `notifySkip` refuses to notify about a weekend.
 *
 * A schedule edited to a time that passed less than `windowMs` ago fires on the
 * next tick. That is intended: the slot is still inside its on-time window.
 */
export function dueSlots(
  rows: Iterable<Schedule>,
  now: Date,
  alreadyFired: ReadonlySet<string>,
  windowMs: number,
): DueSlot[] {
  const manilaDate = manilaDateString(now);
  const due: DueSlot[] = [];
  for (const row of rows) {
    if (!row.enabled) continue;
    for (const action of ["in", "out"] as const) {
      const time = action === "in" ? row.clockInTime : row.clockOutTime;
      const slot = expectedFireTime(manilaDate, time);
      const lateBy = now.getTime() - slot.getTime();
      if (lateBy < 0 || lateBy >= windowMs) continue;
      if (alreadyFired.has(slotKey(row.userId, action, manilaDate))) continue;
      due.push({ userId: row.userId, action, manilaDate, slot });
    }
  }
  return due;
}

export function registerSchedule(row: Schedule): void {
  // Atomic swap: always clear any existing registration first.
  unregisterSchedule(row.userId);
  if (!row.enabled) return;
  active.set(row.userId, row);
  logger.info(
    {
      userId: row.userId,
      in: row.clockInTime,
      out: row.clockOutTime,
      days: "Mon-Fri",
      timezone: "Asia/Manila",
    },
    "schedule registered",
  );
}

export function unregisterSchedule(userId: string): void {
  if (!active.delete(userId)) return;
  logger.info({ userId }, "schedule unregistered");
}

export function activeScheduleCount(): number {
  return active.size;
}

export async function loadAllSchedules(): Promise<number> {
  const rows = await db
    .select()
    .from(schedules)
    .where(eq(schedules.enabled, true));
  for (const row of rows) {
    registerSchedule(row);
  }
  return active.size;
}

/**
 * What ONE attempt to fire a slot produced. The tick glue keeps a slot "fired"
 * only when it was HANDLED — see `isSlotHandled`.
 */
export type FireResult =
  | { outcome: "created" } // this fire created the run row
  | { outcome: "existed" } // a run for this slot already existed (the user clicked first)
  | { outcome: "skipped" } // a deliberate skip: holiday, day override or pause window
  | { outcome: "not_started"; reason: "no_credentials" | "already_running" }
  | { outcome: "failed" }; // an error before either a run row or a skip existed

/**
 * Whether the slot is DONE for today — a run row exists, or the skip was
 * deliberate. A `no_credentials` refusal counts as handled too: it is a
 * permanent user-configuration state, not a transient failure, retrying it every
 * tick for twenty minutes would only add noise, and the missed-run sweep still
 * alerts because no run row exists.
 */
export function isSlotHandled(result: FireResult): boolean {
  if (result.outcome === "created" || result.outcome === "existed") return true;
  if (result.outcome === "skipped") return true;
  return result.outcome === "not_started" && result.reason === "no_credentials";
}

/**
 * Fire one due slot. Skips it when a run for this user and action already
 * started at or after the slot: the user clicked first, or a previous process
 * fired it and then restarted inside the window. If that lookup fails, fire
 * anyway — a missed clock-in is worse than a duplicate, and the automation's
 * already-clocked guard turns a duplicate into `skipped`.
 */
async function fireDueSlot(due: DueSlot, now: Date): Promise<FireResult> {
  const lateByMs = now.getTime() - due.slot.getTime();
  try {
    const existing = await db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.userId, due.userId),
          eq(runs.action, due.action),
          gte(runs.startedAt, due.slot),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      logger.info(
        { userId: due.userId, action: due.action, runId: existing[0]!.id },
        "scheduled slot already has a run — not firing",
      );
      return { outcome: "existed" };
    }
  } catch (err: unknown) {
    logger.error(
      { userId: due.userId, action: due.action, err },
      "scheduled slot run lookup failed — firing anyway",
    );
  }
  logger.info(
    {
      userId: due.userId,
      action: due.action,
      slot: due.slot.toISOString(),
      lateByMs,
    },
    "scheduled slot due",
  );
  return fireCron(due.userId, due.action, now);
}

// The tick's collaborators, injectable so the glue is unit-testable with no
// database (15C) — the fake-timer tests drive `schedulerTick` directly.
export type SchedulerTickDeps = {
  slots: () => Iterable<Schedule>;
  fire: (due: DueSlot, now: Date) => Promise<FireResult>;
  sweep: () => Promise<void>;
  windowMs: () => number;
};

export const defaultSchedulerTickDeps: SchedulerTickDeps = {
  slots: () => active.values(),
  fire: fireDueSlot,
  sweep: () => sweepMissedRuns(),
  windowMs: fireWindowMs,
};

/** One tick: fire due slots, then the missed-run sweep every 5 minutes. */
export async function schedulerTick(
  now: Date,
  deps: Partial<SchedulerTickDeps> = {},
): Promise<void> {
  const d: SchedulerTickDeps = { ...defaultSchedulerTickDeps, ...deps };
  const today = manilaDateString(now);
  for (const k of fired) {
    if (!k.endsWith(`::${today}`)) fired.delete(k);
  }

  for (const due of dueSlots(d.slots(), now, fired, d.windowMs())) {
    const key = slotKey(due.userId, due.action, due.manilaDate);
    // Claim before any await, so an overlapping tick can't fire it twice. This
    // is a re-entrancy guard, NOT the record — it is removed again below unless
    // the attempt produced a run row or a deliberate skip.
    fired.add(key);
    try {
      const result = await d.fire(due, now);
      if (!isSlotHandled(result)) {
        fired.delete(key);
        logger.warn(
          { userId: due.userId, action: due.action, fire: result },
          "scheduled slot not handled — will try again on the next tick",
        );
      }
    } catch (err: unknown) {
      // The fire path is supposed to resolve rather than throw; belt-and-braces
      // so a future awaited call cannot lose the slot for the day.
      fired.delete(key);
      logger.warn(
        { userId: due.userId, action: due.action, err },
        "scheduled slot fire failed — will try again on the next tick",
      );
    }
  }

  // The missed-run sweep: ONE global pass for all users, on the first tick of
  // every 5-minute wall-clock window (and once at boot). A process that is
  // down cannot report that it is down, so a sweep on a live process
  // reconciles what should have happened against what did. It only alerts on
  // slots past the fire window, so it never races a slot this tick fired.
  // sweepMissedRuns never throws.
  const bucket = Math.floor(now.getTime() / SWEEP_INTERVAL_MS);
  if (bucket !== lastSweepBucket) {
    lastSweepBucket = bucket;
    await d.sweep();
  }
}

/** Start the scheduler on the shared wall-clock tick. Called once at boot. */
export function startScheduler(): void {
  onTick("scheduler", schedulerTick);
  // The retry trigger rides the same tick (15B): a queued retry's `retry_at` is
  // read from the database on every tick, so a retry survives a restart.
  registerRetryTick();
  logger.info(
    {
      tickMs: TICK_MS,
      fireWindowMinutes: config.MISSED_RUN_GRACE_MINUTES,
      sweepEveryMinutes: SWEEP_INTERVAL_MS / 60_000,
      timezone: "Asia/Manila",
    },
    "scheduler started on wall-clock tick",
  );
}

/**
 * The boot gate (phase 15D, D8). ONE place decides whether this process
 * schedules anything time-based, and it logs one line either way:
 *
 *   false (the default) — no daily slots, no retry trigger, no missed-run
 *     sweep. Manual runs and the whole UI still work.
 *   true — rehydrate the enabled schedules and arm the tick.
 *
 * Two hosts with separate databases cannot see each other's unique index, so an
 * unconfigured second machine would happily clock everyone a second time and
 * take the other's OTP email. Opting in is one line in the scheduled host's
 * .env, and it has to be deliberate.
 */
export async function startScheduling(): Promise<boolean> {
  if (!schedulerEnabled()) {
    logger.info(
      { schedulerEnabled: false },
      "scheduler disabled (SCHEDULER_ENABLED is not true) — no daily slots, no retries, no missed-run sweep on this host; manual runs still work",
    );
    return false;
  }
  // Rehydrate enabled schedules from the DB BEFORE the tick can fire.
  const scheduleCount = await loadAllSchedules();
  logger.info({ scheduleCount }, "loaded schedules from database");
  startScheduler();
  logger.info(
    { schedulerEnabled: true, scheduleCount },
    "scheduler enabled (SCHEDULER_ENABLED=true) — daily slots, retries and the missed-run sweep are armed",
  );
  return true;
}

/** Test hook: forget registrations, fired slots and the sweep window. */
export function resetSchedulerState(): void {
  active.clear();
  fired.clear();
  lastSweepBucket = null;
}

/**
 * Fired by the scheduler tick. Asks the Workday gate (phase 16A) whether this
 * user should be clocked on this Manila day, and acts on the answer. Never
 * throws across the tick boundary — the WHOLE path, decision included, sits
 * inside one try, so a database error anywhere is a `failed` result the tick
 * glue retries instead of a lost day (15C, path 5).
 *
 * The `now` param is the tick's instant, and it is threaded through — the gate
 * must not take a second `new Date()`.
 */
export async function fireCron(
  userId: string,
  action: ClockAction,
  now: Date = new Date(),
): Promise<FireResult> {
  // Record the fire first — the scheduler is alive whether or not the fire then
  // enqueues a run. /health reads this as the "scheduler last fired" timestamp.
  lastFireAt = now.toISOString();
  try {
    const manilaDate = manilaDateString(now);
    const decision = await decideDay({ userId, manilaDate, now });
    if (!decision.work) {
      logger.info(
        {
          userId,
          action,
          reason: decision.reason.code,
          detail: decision.reason.label,
        },
        "skipping scheduled run — the workday gate says today is not a work day",
      );
      // Every skip notifies (phase 16D) except a weekend. `dueSlots` yields
      // weekend slots too now (phase 16 review, B1) — the gate decides
      // work/non-work — so a weekend arrives here as a non-work decision and
      // `notifySkip` refuses it, keeping the day silent. Fire-and-forget: a dead
      // Telegram endpoint must not change the skip decision or delay anything
      // (hard rule 11).
      // Idempotent via the database (one notice per user per Manila day), so
      // the in/out fires of the same day and a restart cannot duplicate it.
      void notifySkip({ userId, decision, now }).catch(() => {}); // oxlint-disable-line promise/prefer-await-to-then -- sanctioned fire-and-forget idiom (#2), §03.
      // A skip is a deliberate no-run: the slot reached an outcome.
      noteDeliberateSkip(decision.reason.code);
      return { outcome: "skipped" };
    }

    const result = await startRun({ userId, action, manilaDate });
    if (result.ok) {
      logger.info({ userId, action, runId: result.run.id }, "scheduled run enqueued");
      return { outcome: "created" };
    }
    logger.info(
      { userId, action, reason: result.reason },
      "scheduled run not started",
    );
    return { outcome: "not_started", reason: result.reason };
  } catch (err: unknown) {
    logger.error({ userId, action, err }, "scheduled run failed to enqueue");
    return { outcome: "failed" };
  }
}
