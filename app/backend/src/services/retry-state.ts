import { and, eq, inArray, isNotNull, lte } from "drizzle-orm";
import { db } from "../db/client";
import { runs, type Run } from "../db/schema";
import { manilaDateString } from "./workday";
import type { ClockAction } from "../automation/clock";

// The DATABASE half of retry state (phase 15B, D20). A pending retry is a
// property of the latest failed attempt, so it lives on that run's own row as
// `runs.retry_at` (nullable timestamptz): non-null means "a retry is due at
// this instant", null means none (never scheduled, already claimed by the tick,
// or cancelled).
//
// This module replaces `services/retry-registry.ts` — the in-memory Map that
// dropped every queued retry on a restart. It is deliberately DB-only (no
// notifications, no scheduling policy) so that BOTH the retry policy
// (services/retry.ts) and the missed-run sweep (services/notifications.ts) can
// depend on it without an import cycle, which is the same role the old registry
// played.
//
// Day handling: a retry is only ever scheduled for the SAME Manila calendar day
// as the failure it follows — the shortest interval is 1 minute and the
// longest retry time allowed is the action's cutoff (≤ 23:00 Manila), so a
// queued retry's `retry_at` never crosses midnight. Callers therefore identify
// a pending retry by the Manila day of the run it belongs to, and the row
// lookups below filter on `retry_at`'s own Manila day to keep the two in step.

export type PendingRetry = {
  /** The failed run carrying `retry_at`. */
  runId: string;
  /** The attempt number the queued retry will run as (the failed attempt + 1). */
  attempt: number;
  /** When the retry is due. */
  retryAt: Date;
};

/**
 * Queue a retry on the failed run's own row. Durable on purpose: this is the
 * write that survives a restart, so it is awaited before the caller reports
 * that a retry is pending.
 */
export async function setRetryAt(runId: string, retryAt: Date): Promise<void> {
  await db.update(runs).set({ retryAt }).where(eq(runs.id, runId));
}

/** Rows with a queued retry for one user+action (the raw, day-agnostic set). */
async function rowsWithRetry(
  userId: string,
  action: ClockAction,
): Promise<{ id: string; attempt: number; retryAt: Date | null }[]> {
  return db
    .select({ id: runs.id, attempt: runs.attempt, retryAt: runs.retryAt })
    .from(runs)
    .where(
      and(
        eq(runs.userId, userId),
        eq(runs.action, action),
        isNotNull(runs.retryAt),
      ),
    );
}

/**
 * The queued retry for (user, action, Manila day), if any. The Manila day is
 * matched against `retry_at` itself — the instant the retry will run — so a
 * retry cancelled or claimed for another day can never suppress this day's
 * missed-run alert.
 */
export async function findPendingRetry(
  userId: string,
  action: ClockAction,
  manilaDate: string,
): Promise<PendingRetry | undefined> {
  const rows = await rowsWithRetry(userId, action);
  const row = rows.find(
    (r) => r.retryAt !== null && manilaDateString(r.retryAt) === manilaDate,
  );
  if (!row || row.retryAt === null) return undefined;
  return { runId: row.id, attempt: row.attempt + 1, retryAt: row.retryAt };
}

/** True when a retry is queued for (user, action, Manila day). */
export async function hasPendingRetry(
  userId: string,
  action: ClockAction,
  manilaDate: string,
): Promise<boolean> {
  return (await findPendingRetry(userId, action, manilaDate)) !== undefined;
}

/**
 * Cancel the queued retry for (user, action, Manila day). Safe to call when
 * none exists. Returns how many rows were cleared.
 */
export async function clearPendingRetry(
  userId: string,
  action: ClockAction,
  manilaDate: string,
): Promise<number> {
  const rows = await rowsWithRetry(userId, action);
  const ids = rows
    .filter((r) => r.retryAt !== null && manilaDateString(r.retryAt) === manilaDate)
    .map((r) => r.id);
  if (ids.length === 0) return 0;
  const cleared = await db
    .update(runs)
    .set({ retryAt: null })
    .where(inArray(runs.id, ids))
    .returning({ id: runs.id });
  return cleared.length;
}

/**
 * Cancel EVERY queued retry for a user, whatever the day. Account deletion
 * calls this through the Run lifecycle: the cascade would take the rows
 * anyway, but a retry must never fire against an account on its way out.
 */
export async function cancelAllPendingRetries(userId: string): Promise<number> {
  const cleared = await db
    .update(runs)
    .set({ retryAt: null })
    .where(and(eq(runs.userId, userId), isNotNull(runs.retryAt)))
    .returning({ id: runs.id });
  return cleared.length;
}

/** Every queued retry whose due time has arrived. */
export async function loadDueRetries(now: Date): Promise<Run[]> {
  return db
    .select()
    .from(runs)
    .where(and(isNotNull(runs.retryAt), lte(runs.retryAt, now)));
}

/**
 * Claim one due retry atomically. The single UPDATE is the claim: the first
 * caller nulls `retry_at` and gets the row back, every other caller (a second
 * tick, a restarted process racing the old one) gets nothing — so a due retry
 * can never fire twice. Never a SELECT-then-UPDATE: that loses the race.
 */
export async function claimRetry(runId: string): Promise<Run | undefined> {
  const [claimed] = await db
    .update(runs)
    .set({ retryAt: null })
    .where(and(eq(runs.id, runId), isNotNull(runs.retryAt)))
    .returning();
  return claimed;
}
