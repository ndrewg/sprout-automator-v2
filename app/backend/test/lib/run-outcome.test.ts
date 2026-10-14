import { describe, expect, it } from "vitest";
import {
  NO_CLOCK_IN_SKIP_REASON,
  shouldScheduleRetry,
  UNKNOWN_OUTCOME,
  unknownOutcomeDetail,
} from "../../src/lib/run-outcome";

// Phase 17 § 17B/§ 17C + D20: the retry rule and the "unknown" vocabulary.
//
// These are pure, and they are the two facts the rest of the system agrees on:
// phase 15's lifecycle asks shouldScheduleRetry before it queues anything, and
// the notifier asks what an outcome is called. A drift between them is exactly
// how a double clock would get scheduled.

describe("shouldScheduleRetry", () => {
  it("retries a plain failure — the phase-14 contract, unchanged", () => {
    expect(shouldScheduleRetry("failure")).toBe(true);
    expect(shouldScheduleRetry("failure", null)).toBe(true);
  });

  it("NEVER retries an unknown failure (phase 17)", () => {
    // The whole point: the click may have landed, so a retry could put a second
    // record on the day. It is stored as status='failure' + outcome='unknown',
    // which is why the status alone cannot make this decision.
    expect(shouldScheduleRetry("failure", UNKNOWN_OUTCOME)).toBe(false);
  });

  it("never retries a skip or a success", () => {
    // Phase 14's hard constraint: a skipped run fails safe on doubt, so
    // retrying one turns an uncertain read into repeated clock attempts.
    expect(shouldScheduleRetry("skipped")).toBe(false);
    expect(shouldScheduleRetry("skipped", UNKNOWN_OUTCOME)).toBe(false);
    expect(shouldScheduleRetry("success")).toBe(false);
  });

  it("does not retry a run that has not ended", () => {
    expect(shouldScheduleRetry("pending")).toBe(false);
    expect(shouldScheduleRetry("running")).toBe(false);
  });
});

describe("unknownOutcomeDetail", () => {
  it("names the state and tells the user to check HRHub first", () => {
    // The alert renders this under a "<action> state unknown" header, so the
    // sentence a user reads is phase 17 § 17B's message verbatim.
    expect(unknownOutcomeDetail()).toBe(
      "HRHub didn't confirm and the attendance card doesn't show it. " +
        "Check HRHub before clocking manually.",
    );
  });

  it("carries no secret and no stack trace", () => {
    expect(unknownOutcomeDetail()).not.toMatch(/password|token|\/Users\/|at Object\./);
  });
});

describe("NO_CLOCK_IN_SKIP_REASON", () => {
  it("is the exact sentence the notifier recognises as an alert", () => {
    expect(NO_CLOCK_IN_SKIP_REASON).toBe(
      "no clock-in found today, not clocking out",
    );
  });
});
