import { describe, it, expect } from "vitest";
import { isPhilippineHoliday } from "../../src/lib/ph-holidays";

// The pure LIBRARY lookup (date-holidays, PH). The Manila clock helpers and the
// Workday gate that layers EXTRA_HOLIDAYS and per-user overrides on top live in
// services/workday.ts and are covered by test/services/workday.test.ts.

describe("isPhilippineHoliday", () => {
  it("returns the name for a known public holiday (New Year's Day)", () => {
    // 04:00Z == noon in Manila on Jan 1
    const hit = isPhilippineHoliday(new Date("2026-01-01T04:00:00Z"));
    expect(hit?.name).toBe("New Year's Day");
  });

  it("returns null for an ordinary weekday", () => {
    // 2026-03-10 is a Tuesday with no PH public/bank/optional holiday
    expect(isPhilippineHoliday(new Date("2026-03-10T04:00:00Z"))).toBeNull();
  });

  it("returns type 'optional' for a special non-working day (2026-08-21 Ninoy Aquino Day)", () => {
    const hit = isPhilippineHoliday(new Date("2026-08-21T04:00:00Z"));
    expect(hit?.name).toBe("Ninoy Aquino Day");
    expect(hit?.type).toBe("optional");
    expect(hit?.source).toBe("library");
  });

  it("returns type 'public' for a regular holiday (2026-12-25 Christmas Day)", () => {
    const hit = isPhilippineHoliday(new Date("2026-12-25T04:00:00Z"));
    expect(hit?.name).toBe("Christmas Day");
    expect(hit?.type).toBe("public");
    expect(hit?.source).toBe("library");
  });

  it("returns null for an observance-only day (2026-06-19 José Rizal's birthday)", () => {
    // observance is NOT in SKIP_TYPES — a caller must not skip on it.
    expect(isPhilippineHoliday(new Date("2026-06-19T04:00:00Z"))).toBeNull();
  });

  it("returns null for an ordinary Tuesday (2026-03-10)", () => {
    expect(isPhilippineHoliday(new Date("2026-03-10T04:00:00Z"))).toBeNull();
  });
});
