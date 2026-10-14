import { eq } from "drizzle-orm";
import { config, parseHhmm } from "../config";
import { db } from "../db/client";
import { users, type Run } from "../db/schema";
import { logger } from "../lib/logger";
import { manilaDateString, manilaHhmm } from "./workday";
import { escapeHtml } from "../lib/telegram";
import { stripAnsi, truncateText } from "../lib/text";
import type { ClockAction } from "../automation/clock";
import { dispatch } from "./notifications";
import { hasPendingRetry, setRetryAt } from "./retry-state";

// Retry POLICY and the failure-time decision (phase 14, reworked in phase 15B).
//
// What lives here: the pure scheduling arithmetic (interval + cap + wall-clock
// cutoff), the messages, and `scheduleRetryOnFailure` — the decision the Run
// lifecycle's terminal step makes when a run ends in `failure`.
//
// What does NOT live here any more (phase 15B): the pending-retry STATE. It used
// to be an in-memory Map in `services/retry-registry.ts`, which a restart threw
// away — the user was told "will retry at 06:05" and then heard nothing, ever.
// It is now `runs.retry_at` (services/retry-state.ts), claimed atomically by the
// tick. The tick itself is a TRIGGER, so it lives in the Run lifecycle
// (services/run-lifecycle.ts) next to the other two triggers.
//
// Hard constraint, unchanged from phase 14: retry `failure` ONLY, never
// `skipped`. `isAlreadyClockedForToday` fails safe by skipping on doubt, so
// retrying a skip turns one uncertain read into repeated clock attempts — the
// exact double-clock `runs_one_active_per_user` exists to prevent.

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

/** The Manila HH:mm past which a retry for `action` is abandoned. */
export function cutoffFor(action: ClockAction, policy: RetryPolicy): string {
  return action === "in" ? policy.cutoffClockIn : policy.cutoffClockOut;
}

/** True when an instant's Manila wall-clock time is past the HH:mm cutoff. */
export function pastCutoff(dt: Date, cutoffHhmm: string): boolean {
  const { hour: ch, minute: cm } = parseHhmm(cutoffHhmm);
  const cutoffMin = ch * 60 + cm;
  const wall = manilaHhmm(dt);
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
  const cutoff = cutoffFor(action, policy);
  const next = new Date(failedAt.getTime() + policy.intervalMinutes * 60_000);
  if (pastCutoff(next, cutoff)) return null;
  // A retry belongs to the Manila day it was failed on. Without this, a
  // clock-out failure at 23:45 with a 30-minute interval queues a 00:15 attempt
  // TOMORROW — which the cutoff check cannot see, because 00:15 is before the
  // 23:00 cutoff by the clock. The tick's own day-rollover guard would then
  // discard it (and message someone at midnight); refusing it here means no
  // retry is ever queued for a day it does not belong to.
  if (manilaDateString(next) !== manilaDateString(failedAt)) return null;
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

/**
 * The terminal message of a failed run that will NOT be retried: the cap is
 * reached, the wall-clock cutoff has passed, the day rolled over, or a restored
 * retry was discarded. It replaces the per-attempt ⚠️ (phase 14B: one bad
 * morning must not produce one message per attempt), and it carries the
 * failure's own error so the diagnosis is not lost with the ⚠️.
 */
export function renderRetryGiveUpMessage(
  action: ClockAction,
  attempts: number,
  error: string | null = null,
): string {
  const label = action === "in" ? "Clock-in" : "Clock-out";
  const verb = action === "in" ? "in" : "out";
  const head =
    attempts >= 1
      ? `${label} failed ${attempts} ${attempts === 1 ? "time" : "times"} and gave up`
      : `${label} failed and gave up`;
  const body = error
    ? `\n${escapeHtml(truncateText(stripAnsi(error)))}`
    : "";
  return `🛑 <b>${head}</b>${body}\nPlease clock ${verb} manually in HRHub.`;
}

// --- Dispatch (fire-and-forget; a dead Telegram endpoint never affects a run) --

/**
 * "Say the default exactly once": the first retry scheduled for a user who has
 * never seen the explanation mentions the default; afterwards, silent. The flag
 * is set on the dispatch attempt, not on a successful send, so a user who
 * enables notifications later is not spammed retroactively.
 */
export async function notifyRetryScheduled(
  userId: string,
  action: ClockAction,
  nextAt: Date,
): Promise<void> {
  try {
    const [u] = await db
      .select({ shown: users.retryIntroShown })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const showDefault = !u?.shown;
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

/** One terminal "gave up" message for a failed run. Never throws. */
export async function notifyRetryGiveUp(
  run: Pick<Run, "userId" | "action" | "attempt" | "error">,
): Promise<void> {
  try {
    await dispatch(
      run.userId,
      renderRetryGiveUpMessage(run.action, run.attempt, run.error),
      "retry",
    );
  } catch (err: unknown) {
    logger.error({ userId: run.userId, action: run.action, err }, "retry give-up notification failed");
  }
}

// --- The failure-time decision --------------------------------------------------

/**
 * Decide whether a just-failed run should be retried, record the retry durably
 * and send the one message that describes the outcome. Called by the Run
 * lifecycle's terminal step (`finishRun`) for EVERY failure — normal finish,
 * executor backstop and orphan recovery alike — so no path can end a run
 * without a decision.
 *
 * The interval is measured from the failure instant — the run's `finishedAt`,
 * or an injected `now` (tests). A production failure at 05:35 queues the 06:05
 * attempt; the wall-clock cutoff then correctly refuses an afternoon retry even
 * before the cap is reached.
 *
 * Returns the outcome so the caller can decide the message:
 *   - "retry":    a retry is queued in the database. On the first failure this
 *                 also sent "will retry at HH:MM"; on later attempts the retry
 *                 already explained itself (14B: silence between attempts).
 *   - "give-up":  the sequence ended (cap, cutoff, or day rollover). A give-up
 *                 message was sent. The caller suppresses the standard ⚠️.
 *   - "none":     nothing was scheduled and nothing was sent (the run was not a
 *                 failure). The caller keeps the standard message.
 *
 * The messages are fired fire-and-forget (`void notify…`): a dead Telegram
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

  // Day rollover: a retry belongs to its own Manila day and must never fire for
  // another one. The message already promised an attempt, so say it will not
  // happen instead of going quiet.
  if (manilaDateString(anchor) !== manilaDate) {
    logger.info(
      { runId: run.id, action: run.action, manilaDate },
      "retry not scheduled — the failed run belongs to another Manila day",
    );
    void notifyRetryGiveUp(run);
    return "give-up";
  }

  // A retry is already queued for this user/action/day — it covers this
  // failure, so do not stack a second one and do not re-announce it.
  if (await hasPendingRetry(run.userId, run.action, manilaDate)) return "retry";

  const next = nextAttempt(anchor, run.action, run.attempt, policy);
  if (next === null) {
    void notifyRetryGiveUp(run);
    return "give-up";
  }

  // Durable BEFORE reporting the retry: a restart must not lose it (15B).
  await setRetryAt(run.id, next);

  if (run.attempt === 0) {
    void notifyRetryScheduled(run.userId, run.action, next);
  }
  return "retry";
}
