import type { ClockAction } from "../automation/clock";
import { manilaHhmm, onTick } from "../lib/wall-clock-tick";

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
//
// Firing is driven by the shared wall-clock tick (lib/wall-clock-tick.ts), NOT
// a timer per retry: a pending retry fires on the first tick at or after its
// `fireAt`, however late that tick is. It used to be a one-shot node-cron task,
// which a drifting monotonic clock could make skip (see D8). An entry stays in
// the map after firing (so hasPendingRetry stays true while the attempt runs)
// until attemptRun cancels it; `fired` stops a second fire in the meantime.

type PendingEntry = {
  attempt: number;
  fireAt: Date;
  onFire: () => void;
  fired: boolean;
};

// "userId::action::manilaDate" -> the pending retry.
const pending = new Map<string, PendingEntry>();

const key = (userId: string, action: ClockAction, manilaDate: string): string =>
  `${userId}::${action}::${manilaDate}`;

/** "HH:mm" in Asia/Manila for an instant. */
export function manilaWallTime(dt: Date): string {
  return manilaHhmm(dt);
}

/** Fire every pending retry whose time has come. Exported for tests. */
export function fireDueRetries(now: Date): void {
  for (const entry of pending.values()) {
    if (entry.fired || now.getTime() < entry.fireAt.getTime()) continue;
    entry.fired = true;
    entry.onFire();
  }
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
  pending.set(key(userId, action, manilaDate), {
    attempt,
    fireAt,
    onFire,
    fired: false,
  });
  onTick("retries", fireDueRetries);
}

/** Cancel any pending retry for (user, action, date). Safe to call when none
 *  exists. */
export function cancelPendingRetry(
  userId: string,
  action: ClockAction,
  manilaDate: string,
): void {
  pending.delete(key(userId, action, manilaDate));
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
  pending.clear();
}
