import { describe, it, expect } from "vitest";
import {
  manilaDateString,
  isPausedOn,
  isPhilippineHoliday,
} from "../../src/lib/ph-holidays";

describe("manilaDateString", () => {
  it("formats a UTC instant in Asia/Manila (+08)", () => {
    // 2026-06-24T20:00Z is 2026-06-25T04:00 in Manila (next day)
    expect(manilaDateString(new Date("2026-06-24T20:00:00Z"))).toBe("2026-06-25");
    // 2026-06-24T03:00Z is 2026-06-24T11:00 in Manila (same day)
    expect(manilaDateString(new Date("2026-06-24T03:00:00Z"))).toBe("2026-06-24");
  });
});

describe("isPhilippineHoliday", () => {
  it("returns a name for a known public holiday (New Year's Day)", () => {
    // 04:00Z == noon in Manila on Jan 1
    expect(isPhilippineHoliday(new Date("2026-01-01T04:00:00Z"))).toBeTruthy();
  });

  it("returns null for an ordinary weekday", () => {
    // 2026-03-10 is a Tuesday with no PH public/bank holiday
    expect(isPhilippineHoliday(new Date("2026-03-10T04:00:00Z"))).toBeNull();
  });
});

describe("isPausedOn", () => {
  // Window: Mon 2026-08-10 … Fri 2026-08-14. Instants are chosen so noon in
  // Manila lands on the target Manila calendar day.
  const WINDOW = { pausedFrom: "2026-08-10", pausedUntil: "2026-08-14" };

  it("is false before the window opens", () => {
    // 2026-08-07 (Friday) — day before the window.
    expect(
      isPausedOn(WINDOW, new Date("2026-08-07T04:00:00Z")),
    ).toBe(false);
  });

  it("is true on the first day (inclusive lower bound)", () => {
    expect(
      isPausedOn(WINDOW, new Date("2026-08-10T04:00:00Z")),
    ).toBe(true);
  });

  it("is true in the middle of the window", () => {
    expect(
      isPausedOn(WINDOW, new Date("2026-08-12T04:00:00Z")),
    ).toBe(true);
  });

  it("is true on the last day (inclusive upper bound)", () => {
    expect(
      isPausedOn(WINDOW, new Date("2026-08-14T04:00:00Z")),
    ).toBe(true);
  });

  it("is false the day after the window closes", () => {
    // 2026-08-17 (Monday).
    expect(
      isPausedOn(WINDOW, new Date("2026-08-17T04:00:00Z")),
    ).toBe(false);
  });

  it("is false when both columns are null", () => {
    expect(isPausedOn({ pausedFrom: null, pausedUntil: null })).toBe(false);
  });

  it("is false when only one column is set (invalid input fails safe)", () => {
    expect(
      isPausedOn({ pausedFrom: "2026-08-10", pausedUntil: null }),
    ).toBe(false);
    expect(
      isPausedOn({ pausedFrom: null, pausedUntil: "2026-08-14" }),
    ).toBe(false);
  });

  it("defaults to the real current date", () => {
    // Called with no date, the helper compares against today in Manila. It must
    // return a boolean either way and agree with an explicit now.
    const today = new Date();
    expect(typeof isPausedOn(WINDOW)).toBe("boolean");
    expect(isPausedOn(WINDOW)).toBe(
      manilaDateString(today) >= WINDOW.pausedFrom &&
        manilaDateString(today) <= WINDOW.pausedUntil,
    );
  });
});
