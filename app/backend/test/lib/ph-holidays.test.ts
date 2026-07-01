import { describe, it, expect } from "vitest";
import {
  manilaDateString,
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
