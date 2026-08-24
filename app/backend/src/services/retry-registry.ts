import cron, { type ScheduledTask } from "node-cron";
import type { ClockAction } from "../automation/clock";

// The in-memory one-shot retry registry (phase 14). Holds at most one pending
// retry per (user, action, Manila date) and lets callers schedule, cancel, or
// probe it. Deliberately notification-free and DB-free so that BOTH
// services/retry.ts (the orchestrator) and services/notifications.ts (the
// missed-run sweep, which must suppress its alert while a retry is pending)
// can depend on it without a cycle.
//
// The registry is in-memory on purpose: a restart drops queued retries. That is
// a documented limitation (see the phase report) — a process that was itself
// down cannot retry (that is phase 12's dead-man's-switch), and a retry that
// survives a restart is not worth the persisted state.

type PendingEntry = { task: ScheduledTask; attempt: number; fireAt: Date };

// userId -> action -> manilaDate -> the pending retry.
const pending = new Map<string, PendingEntry>();

const key = (userId: string, action: ClockAction, manilaDate: string): string =>
  `${userId}::${action}::${manilaDate}`;

const wallTimeFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Manila",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** "HH:mm" in Asia/Manila for an instant. */
export function manilaWallTime(dt: Date): string {
  return wallTimeFmt.format(dt);
}

/** "HH:mm" (Manila) -> a node-cron 5-field expression that fires daily at that
 *  wall time in the Asia/Manila timezone. Used for one-shot retries: since a
 *  retry always targets the CURRENT Manila day, "m h * * *" fires today at the
 *  right wall time, and the attempt's own day-rollover re-check cancels it if
 *  the wall clock ever passes to another day. */
export function wallTimeCronExpr(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return `${m} ${h} * * *`;
}

export type OneShotRetryParams = {
  userId: string;
  action: ClockAction;
  manilaDate: string;
  attempt: number;
  fireAt: Date;
  onFire: () => void;
};

/** Register a one-shot retry. Any existing pending retry for the same
 *  (user, action, date) is replaced (the newer attempt supersedes it). */
export function scheduleOneShotRetry(params: OneShotRetryParams): void {
  const { userId, action, manilaDate, attempt, fireAt, onFire } = params;
  cancelPendingRetry(userId, action, manilaDate);
  const expr = wallTimeCronExpr(manilaWallTime(fireAt));
  const task = cron.schedule(
    expr,
    onFire,
    { timezone: "Asia/Manila", maxExecutions: 1 },
  );
  pending.set(key(userId, action, manilaDate), { task, attempt, fireAt });
}

/** Cancel any pending retry for (user, action, date). Safe to call when none
 *  exists. */
export function cancelPendingRetry(
  userId: string,
  action: ClockAction,
  manilaDate: string,
): void {
  const k = key(userId, action, manilaDate);
  const entry = pending.get(k);
  if (!entry) return;
  // node-cron v4 types destroy() as void | Promise<void>; the union makes
  // no-floating-promises flag it, so mark the deliberate non-await explicitly
  // (same pattern as scheduler.ts's stop()).
  void entry.task.destroy();
  pending.delete(k);
}

/** True when a retry is currently pending for (user, action, date). */
export function hasPendingRetry(
  userId: string,
  action: ClockAction,
  manilaDate: string,
): boolean {
  return pending.has(key(userId, action, manilaDate));
}

/** The attempt number of the pending retry for (user, action, date), if any. */
export function pendingAttempt(
  userId: string,
  action: ClockAction,
  manilaDate: string,
): number | undefined {
  return pending.get(key(userId, action, manilaDate))?.attempt;
}

/** Test hook: clear the whole registry (used between integration tests). */
export function clearPendingRetries(): void {
  for (const entry of pending.values()) {
    void entry.task.destroy();
  }
  pending.clear();
}
