import { describe, expect, it } from "vitest";
import { parseHhmm } from "../../src/config";
import {
  currentPolicy,
  nextAttempt,
  pastCutoff,
  renderRetryGiveUpMessage,
  renderRetryScheduledMessage,
  type RetryPolicy,
} from "../../src/services/retry";
import {
  manilaWallTime,
  wallTimeCronExpr,
} from "../../src/services/retry-registry";

// Phase 14 unit tests: the scheduling arithmetic is pure and takes an injected
// clock — no Date.now() inside the schedulable logic (BACKLOG §11). The cutoff
// math is tested directly against Manila wall-clock times.

const POLICY: RetryPolicy = {
  intervalMinutes: 30,
  maxAttempts: 3,
  cutoffClockIn: "12:00",
  cutoffClockOut: "23:00",
};

// A failure at 05:35 Manila on Monday 2026-08-10.
const FAILED_AT = new Date("2026-08-10T05:35:00+08:00");

describe("manilaWallTime / wallTimeCronExpr", () => {
  it("formats an instant as Manila HH:mm", () => {
    expect(manilaWallTime(new Date("2026-08-10T05:35:00+08:00"))).toBe("05:35");
    // UTC 2026-08-10T01:00:00Z is 09:00 Manila (UTC+8).
    expect(manilaWallTime(new Date("2026-08-10T01:00:00Z"))).toBe("09:00");
  });

  it("builds a 5-field cron expression from a wall time", () => {
    expect(wallTimeCronExpr("05:35")).toBe("35 5 * * *");
    expect(wallTimeCronExpr("23:00")).toBe("0 23 * * *");
  });
});

describe("parseHhmm (config)", () => {
  it("accepts valid HH:mm and rejects malformed / out-of-range values", () => {
    expect(parseHhmm("12:00")).toEqual({ hour: 12, minute: 0 });
    expect(parseHhmm("5:30")).toEqual({ hour: 5, minute: 30 });
    expect(() => parseHhmm("24:00")).toThrow(/range/);
    expect(() => parseHhmm("12:60")).toThrow(/range/);
    expect(() => parseHhmm("noon")).toThrow(/HH:mm/);
  });
});

describe("pastCutoff — the wall-clock brake", () => {
  it("is false at or before the cutoff, true after it", () => {
    const atCutoff = new Date("2026-08-10T12:00:00+08:00");
    const before = new Date("2026-08-10T11:59:00+08:00");
    const after = new Date("2026-08-10T12:01:00+08:00");
    expect(pastCutoff(before, "12:00")).toBe(false);
    expect(pastCutoff(atCutoff, "12:00")).toBe(false); // the cutoff itself is allowed
    expect(pastCutoff(after, "12:00")).toBe(true);
  });

  it("compares Manila wall time, not the caller's timezone", () => {
    // 04:01 UTC = 12:01 Manila, which IS past a 12:00 cutoff even though the
    // UTC hour (4) is nowhere near noon.
    const instant = new Date("2026-08-10T04:01:00Z");
    expect(pastCutoff(instant, "12:00")).toBe(true);
  });
});

describe("nextAttempt — interval + cap + cutoff, all injected", () => {
  it("schedules attempt 1 at failure + interval", () => {
    const next = nextAttempt(FAILED_AT, "in", 0, POLICY);
    expect(next).toEqual(new Date("2026-08-10T06:05:00+08:00"));
  });

  it("each retry advances by the interval", () => {
    const a1 = nextAttempt(FAILED_AT, "in", 0, POLICY);
    const a2 = a1 ? nextAttempt(a1, "in", 1, POLICY) : null;
    expect(a2).toEqual(new Date("2026-08-10T06:35:00+08:00"));
  });

  it("the cap holds: attempt >= maxAttempts schedules nothing", () => {
    // The third retry (attempt 3) is not allowed with maxAttempts 3.
    expect(nextAttempt(FAILED_AT, "in", 3, POLICY)).toBeNull();
    expect(nextAttempt(FAILED_AT, "in", 4, POLICY)).toBeNull();
  });

  it("the cutoff holds independently of the cap: a long interval walking into the afternoon is stopped even though attempts remain", () => {
    // 3h interval, cutoff 12:00: attempt 0 fails at 09:30; attempt 1 would be
    // 12:30 — past the cutoff, so null, even though attempt 1 <= maxAttempts.
    const longPolicy: RetryPolicy = {
      intervalMinutes: 180,
      maxAttempts: 5,
      cutoffClockIn: "12:00",
      cutoffClockOut: "23:00",
    };
    const at = new Date("2026-08-10T09:30:00+08:00");
    expect(nextAttempt(at, "in", 0, longPolicy)).toBeNull();
    // Same instant, clock-out action: 12:30 is fine before the 23:00 cutoff.
    expect(nextAttempt(at, "out", 0, longPolicy)).toEqual(
      new Date("2026-08-10T12:30:00+08:00"),
    );
  });

  it("clock-in and clock-out use their own cutoffs", () => {
    const lateIn = new Date("2026-08-10T23:00:00+08:00");
    // 23:00 + 30min = 23:30, past the 12:00 clock-in cutoff -> null.
    expect(nextAttempt(lateIn, "in", 0, POLICY)).toBeNull();
    // Same instant for clock-out: 23:30 is past the 23:00 cutoff too.
    expect(nextAttempt(lateIn, "out", 0, POLICY)).toBeNull();
    // 22:00 + 30min = 22:30, fine for clock-out before 23:00.
    const okOut = new Date("2026-08-10T22:00:00+08:00");
    expect(nextAttempt(okOut, "out", 0, POLICY)).toEqual(
      new Date("2026-08-10T22:30:00+08:00"),
    );
  });
});

describe("message rendering", () => {
  it("the retry-scheduled message names the next attempt time", () => {
    const msg = renderRetryScheduledMessage(
      "in",
      new Date("2026-08-10T06:05:00+08:00"),
      false,
    );
    expect(msg).toContain("Clock-in failed — will retry");
    expect(msg).toContain("06:05");
    expect(msg).not.toContain("Retrying every");
  });

  it("the default explanation is appended only when showDefault is true", () => {
    const withDefault = renderRetryScheduledMessage(
      "in",
      new Date("2026-08-10T06:05:00+08:00"),
      true,
    );
    expect(withDefault).toContain("Retrying every");
    const withoutDefault = renderRetryScheduledMessage(
      "in",
      new Date("2026-08-10T06:05:00+08:00"),
      false,
    );
    expect(withoutDefault).not.toContain("Retrying every");
  });

  it("the give-up message counts attempts and asks for a manual clock", () => {
    expect(renderRetryGiveUpMessage("in", 3)).toContain(
      "Clock-in failed 3 times and gave up",
    );
    expect(renderRetryGiveUpMessage("in", 3)).toContain(
      "Please clock in manually in HRHub.",
    );
    expect(renderRetryGiveUpMessage("out", 1)).toContain("1 time");
  });
});

describe("currentPolicy (config defaults)", () => {
  it("reflects the config defaults without env overrides", () => {
    const policy = currentPolicy();
    expect(policy.intervalMinutes).toBe(30);
    expect(policy.maxAttempts).toBe(3);
    expect(policy.cutoffClockIn).toBe("12:00");
    expect(policy.cutoffClockOut).toBe("23:00");
  });
});