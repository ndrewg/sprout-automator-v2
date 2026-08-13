import { describe, expect, it } from "vitest";
import { formatRunDate } from "./dates";

// The clock is INJECTED, and the test proves it: `now` is pinned to 2026-08-13
// (a Thursday). A formatter that read Date.now() (today, whatever the wall
// clock says) would fail the prior-year case below, because the 2025 date
// would render as a current-year weekday string instead of carrying the year.
const NOW = new Date(2026, 7, 13, 12, 0, 0);

// Build a local Date, round-trip through ISO like the real runs.startedAt
// values do. Local calendar days survive the round-trip in any timezone, so
// the assertions below hold on whatever machine the suite runs on.
function atLocal(y: number, m: number, d: number, hour = 9, minute = 0): string {
  return new Date(y, m - 1, d, hour, minute).toISOString();
}

describe("formatRunDate", () => {
  it("renders Today for the same local calendar day", () => {
    expect(formatRunDate(atLocal(2026, 8, 13, 6), NOW, "en-US")).toBe("Today");
    expect(formatRunDate(atLocal(2026, 8, 13, 23), NOW, "en-US")).toBe("Today");
  });

  it("renders Yesterday for the previous local calendar day", () => {
    expect(formatRunDate(atLocal(2026, 8, 12, 23, 59), NOW, "en-US")).toBe(
      "Yesterday",
    );
  });

  it("renders a weekday + day + month string for older local days", () => {
    // 2026-08-11 is a Tuesday.
    expect(formatRunDate(atLocal(2026, 8, 11, 9), NOW, "en-US")).toBe(
      "Tue 11 Aug",
    );
  });

  it("includes the year only when the date is not the current year", () => {
    // 2025-08-13 is a Wednesday.
    expect(formatRunDate(atLocal(2025, 8, 13, 9), NOW, "en-US")).toBe(
      "Wed 13 Aug 2025",
    );
  });

  it("does not call Date.now(): a far-past injected clock still wins", () => {
    const past = new Date(2020, 0, 15, 12);
    expect(formatRunDate(atLocal(2020, 1, 15, 9), past, "en-US")).toBe("Today");
  });
});
