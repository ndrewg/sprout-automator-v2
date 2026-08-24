import { describe, it, expect } from "vitest";
import { parseExtraHolidays } from "../../src/lib/extra-holidays";

// 13A — EXTRA_HOLIDAYS parsing. The parser is the thing config.ts calls at boot
// to refuse a malformed entry, so its contract is load-bearing: a silently
// dropped entry would be a holiday that does not skip.

describe("parseExtraHolidays", () => {
  it("returns an empty map when unset (today's behaviour)", () => {
    expect(parseExtraHolidays(undefined).size).toBe(0);
  });

  it("returns an empty map for an empty string", () => {
    expect(parseExtraHolidays("").size).toBe(0);
  });

  it("returns an empty map for a string of only separators", () => {
    expect(parseExtraHolidays(" , , ").size).toBe(0);
  });

  it("parses a valid YYYY-MM-DD=Name entry into an override holiday", () => {
    const map = parseExtraHolidays("2026-11-20=Special Holiday");
    expect(map.size).toBe(1);
    const entry = map.get("2026-11-20");
    expect(entry).toEqual({
      name: "Special Holiday",
      type: "public",
      source: "override",
    });
  });

  it("parses multiple entries, trimming whitespace", () => {
    const map = parseExtraHolidays(
      "2026-11-20=Special Holiday, 2026-12-26=Boxing Day",
    );
    expect(map.size).toBe(2);
    expect(map.get("2026-12-26")?.name).toBe("Boxing Day");
  });

  it("refuses an entry missing the = separator, naming the position", () => {
    expect(() => parseExtraHolidays("2026-11-20 Special Holiday")).toThrow(
      /entry 1/,
    );
    expect(() => parseExtraHolidays("2026-11-20 Special Holiday")).toThrow(
      /missing a "="/,
    );
  });

  it("refuses an entry with an empty name, naming the position", () => {
    expect(() => parseExtraHolidays("2026-11-20=")).toThrow(/entry 1/);
    expect(() => parseExtraHolidays("2026-11-20=")).toThrow(/empty name/);
  });

  it("refuses a non-real calendar date (2026-02-31), not just a bad shape", () => {
    // 2026 is not a leap year: 2026-02-31 cannot exist.
    expect(() => parseExtraHolidays("2026-02-31=Nope")).toThrow(/entry 1/);
    expect(() => parseExtraHolidays("2026-02-31=Nope")).toThrow(
      /not a real calendar date/,
    );
  });

  it("refuses an out-of-range month", () => {
    expect(() => parseExtraHolidays("2026-13-01=Nope")).toThrow(/entry 1/);
  });

  it("refuses a malformed date shape", () => {
    expect(() => parseExtraHolidays("2026/11/20=Nope")).toThrow(/entry 1/);
  });

  it("accepts a leap-day 2028-02-29", () => {
    const map = parseExtraHolidays("2028-02-29=Leap Day");
    expect(map.get("2028-02-29")?.name).toBe("Leap Day");
  });

  it("names the offending entry in the error, sanitised to one line", () => {
    expect(() => parseExtraHolidays("bad\nentry=Nope")).toThrow(/entry 1/);
  });
});
