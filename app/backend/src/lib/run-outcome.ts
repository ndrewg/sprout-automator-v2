// The machine-readable outcome of a clock attempt (phase 17, D20).
//
// `runs.status` keeps its five-value lifecycle enum (pending, running, success,
// skipped, failure) — the partial unique index `runs_one_active_per_user` and
// every existing query are built on it, so phase 17 deliberately does NOT add a
// status value. What it adds is a second, narrower signal: what HRHub was
// VERIFIED to have done after the click.
//
//   "unknown"  — the click may or may not have landed. HRHub showed no
//                confirmation AND the attendance card does not show the row
//                either, so the app cannot say whether a record now exists.
//                Stored as `status = 'failure'` + `outcome = 'unknown'`,
//                alerted, and NEVER auto-retried: a retry is a second clock
//                against a day whose state is unknown, which is exactly the
//                double-clock this phase exists to prevent. A human checks
//                HRHub — the alert says so.
//
//   null       — every other outcome. `status` alone already says it, and
//                inventing vocabulary for "ordinary success" would make the
//                column mean two different things at once.
//
// Both halves live here rather than in run-lifecycle.ts so the retry decision
// is testable without a database, and so the notifier and the lifecycle cannot
// drift apart on what "unknown" is called.

export const UNKNOWN_OUTCOME = "unknown";

export type StoredOutcome = typeof UNKNOWN_OUTCOME;

/** What one clock attempt concluded. Superset of the persisted status values. */
export type ClockAttemptOutcome =
  | "success"
  | "skipped"
  | "failure"
  | StoredOutcome;

/**
 * Whether a terminal run should queue a retry (phase 14's rule, tightened by
 * phase 17).
 *
 * `failure` ONLY — never `skipped` (a skip fails safe on doubt, so retrying one
 * turns an uncertain read into repeated clock attempts), and never `unknown`
 * (the app cannot tell whether the click landed; a retry could put a second
 * record on the day). Everything retryable happens BEFORE the confirmation
 * click, where "nothing was dispatched" is a fact.
 */
export function shouldScheduleRetry(
  status: string,
  outcome?: string | null,
): boolean {
  if (status !== "failure") return false;
  return outcome !== UNKNOWN_OUTCOME;
}

/** The human-facing label for an action, as used in every run message. */
export function actionLabel(action: "in" | "out"): string {
  return action === "in" ? "Clock-in" : "Clock-out";
}

/**
 * The body of the "unknown" alert — phase 17 § 17B's message.
 *
 * The sent header is `${actionLabel(action)} state unknown`, so the sentence a
 * user reads is exactly:
 *
 *   Clock-in state unknown: HRHub didn't confirm and the attendance card
 *   doesn't show it. Check HRHub before clocking manually.
 *
 * Action-aware on purpose: a clock-out that cannot be confirmed is a different
 * thing to act on than a clock-in, and "Clock-in state unknown" on a clock-out
 * run would be actively misleading.
 */
export function unknownOutcomeDetail(): string {
  return (
    "HRHub didn't confirm and the attendance card doesn't show it. " +
    "Check HRHub before clocking manually."
  );
}

/**
 * The clock-out guard's reason when today has no clock-in (phase 17 § 17B).
 *
 * A constant, not a regex, so the notifier can recognise this skip by identity:
 * it is the one skip that means "you are NOT clocked in and nothing was done
 * about it", which is an alert rather than a reassurance.
 */
export const NO_CLOCK_IN_SKIP_REASON =
  "no clock-in found today, not clocking out";
