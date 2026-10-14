import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPhilippineHoliday, type HolidayInfo } from "../../src/lib/ph-holidays";

// The workday gate (phase 16A). Nothing here touches a database or the wall
// clock: every collaborator is injected and every instant is passed in
// (BACKLOG § 11 — no Date.now() in logic a test needs to pin).

const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));

vi.mock("../../src/lib/logger", () => ({
  logger: { warn: warnMock, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  addManilaDays,
  decideDay,
  decideRange,
  expectedFireTime,
  formatManilaDay,
  isPausedOn,
  isPausedOnDay,
  isWeekend,
  manilaDateString,
  manilaHhmm,
  nextWorkday,
  resetWorkdayGateWarnings,
} from "../../src/services/workday";
import type { WorkdayDeps } from "../../src/services/workday";

const NINO = "2026-08-21"; // Friday — Ninoy Aquino Day, library `optional`
const MAWLID = "2026-08-25"; // Tuesday — an OBSERVANCE, not a skip type

/**
 * A full set of injected deps. The defaults here read nothing: no database, no
 * EXTRA_HOLIDAYS, and the REAL date-holidays library (so the regression cases
 * exercise the actual dataset).
 */
function deps(overrides: Partial<WorkdayDeps> = {}): Partial<WorkdayDeps> {
  return {
    loadOverride: async () => undefined,
    loadOverridesInRange: async () => [],
    loadSchedule: async () => undefined,
    companyHolidays: () => new Map<string, HolidayInfo>(),
    libraryHoliday: isPhilippineHoliday,
    ...overrides,
  };
}

beforeEach(() => {
  warnMock.mockClear();
  resetWorkdayGateWarnings();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Manila clock helpers", () => {
  it("manilaDateString formats a UTC instant in Asia/Manila (+08)", () => {
    expect(manilaDateString(new Date("2026-06-24T20:00:00Z"))).toBe("2026-06-25");
    expect(manilaDateString(new Date("2026-06-24T03:00:00Z"))).toBe("2026-06-24");
  });

  it("manilaHhmm yields Manila wall time", () => {
    expect(manilaHhmm(new Date("2026-08-10T05:35:00+08:00"))).toBe("05:35");
    expect(manilaHhmm(new Date("2026-08-10T01:00:00Z"))).toBe("09:00");
  });

  it("expectedFireTime converts Manila wall-clock date+time to an instant", () => {
    expect(expectedFireTime("2026-08-10", "05:30:00").getTime()).toBe(
      new Date("2026-08-10T05:30:00+08:00").getTime(),
    );
    expect(expectedFireTime("2026-08-10", "18:05:00").getTime()).toBe(
      new Date("2026-08-10T18:05:00+08:00").getTime(),
    );
  });

  it("isWeekend detects weekends from the Manila date string", () => {
    expect(isWeekend("2026-08-08")).toBe(true); // Saturday
    expect(isWeekend("2026-08-09")).toBe(true); // Sunday
    expect(isWeekend("2026-08-10")).toBe(false); // Monday
  });

  it("addManilaDays and formatManilaDay shift and label a Manila day", () => {
    expect(addManilaDays("2026-08-31", 1)).toBe("2026-09-01");
    expect(addManilaDays("2026-09-01", -1)).toBe("2026-08-31");
    expect(formatManilaDay("2026-08-21")).toBe("Fri 21 Aug");
  });

  it("isPausedOn honours an inclusive window and fails safe on a broken pair", () => {
    const WINDOW = { pausedFrom: "2026-08-10", pausedUntil: "2026-08-14" };
    expect(isPausedOnDay(WINDOW, "2026-08-07")).toBe(false);
    expect(isPausedOnDay(WINDOW, "2026-08-10")).toBe(true);
    expect(isPausedOnDay(WINDOW, "2026-08-12")).toBe(true);
    expect(isPausedOnDay(WINDOW, "2026-08-14")).toBe(true);
    expect(isPausedOnDay(WINDOW, "2026-08-17")).toBe(false);
    expect(isPausedOnDay({ pausedFrom: null, pausedUntil: null }, "2026-08-10")).toBe(
      false,
    );
    expect(
      isPausedOnDay({ pausedFrom: "2026-08-10", pausedUntil: null }, "2026-08-10"),
    ).toBe(false);
    expect(isPausedOn(WINDOW, new Date("2026-08-12T04:00:00Z"))).toBe(true);
    expect(isPausedOn(WINDOW, new Date("2026-08-17T04:00:00Z"))).toBe(false);
  });
});

describe("decideDay — the precedence ladder", () => {
  it("6. a plain weekday is a workday", async () => {
    const d = await decideDay({ userId: "u1", manilaDate: "2026-08-11", deps: deps() });
    expect(d.work).toBe(true);
    expect(d.reason.code).toBe("workday");
  });

  it("3. a weekend is a skip (and 5 does not override it)", async () => {
    const d = await decideDay({ userId: "u1", manilaDate: "2026-08-08", deps: deps() });
    expect(d.work).toBe(false);
    expect(d.reason.code).toBe("weekend");
  });

  it("5. a library holiday of a skipping type is a skip, with its name and type", async () => {
    const d = await decideDay({ userId: "u1", manilaDate: NINO, deps: deps() });
    expect(d.work).toBe(false);
    expect(d.reason.code).toBe("holiday");
    expect(d.reason.holidayName).toBe("Ninoy Aquino Day");
    expect(d.reason.holidayType).toBe("optional");
    expect(d.reason.label).toContain("special non-working");
  });

  it("4. a company EXTRA_HOLIDAYS override skips (and wins over the library)", async () => {
    const company = new Map<string, HolidayInfo>([
      ["2026-11-20", { name: "Operator Day", type: "public", source: "override" }],
    ]);
    const d = await decideDay({
      userId: "u1",
      manilaDate: "2026-11-20",
      deps: deps({ companyHolidays: () => company }),
    });
    expect(d.work).toBe(false);
    expect(d.reason.holidaySource).toBe("override");
    expect(d.reason.label).toContain("Operator Day");
    expect(d.reason.label).toContain("company holiday");
  });

  it("2. a pause window is a skip", async () => {
    const d = await decideDay({
      userId: "u1",
      manilaDate: "2026-08-12",
      deps: deps({
        loadSchedule: async () =>
          ({
            pausedFrom: "2026-08-10",
            pausedUntil: "2026-08-14",
          }) as never,
      }),
    });
    expect(d.work).toBe(false);
    expect(d.reason.code).toBe("paused");
  });

  it("1a. the user's skip day skips", async () => {
    const d = await decideDay({
      userId: "u1",
      manilaDate: "2026-08-11",
      deps: deps({
        loadOverride: async () => ({ kind: "skip", note: "dentist" }),
      }),
    });
    expect(d.work).toBe(false);
    expect(d.reason.code).toBe("skip_day");
    expect(d.override).toEqual({ kind: "skip", note: "dentist" });
  });

  it("1b. the user's 'work anyway' day works — over a holiday", async () => {
    const d = await decideDay({
      userId: "u1",
      manilaDate: NINO,
      deps: deps({ loadOverride: async () => ({ kind: "work", note: null }) }),
    });
    expect(d.work).toBe(true);
    expect(d.reason.code).toBe("work_override");
    expect(d.override).toEqual({ kind: "work", note: null });
  });

  it("1c. a user override BEATS a pause on that exact day", async () => {
    const paused = () =>
      ({ pausedFrom: "2026-08-10", pausedUntil: "2026-08-14" }) as never;
    const work = await decideDay({
      userId: "u1",
      manilaDate: "2026-08-12",
      deps: deps({
        loadOverride: async () => ({ kind: "work", note: null }),
        loadSchedule: async () => paused(),
      }),
    });
    expect(work.work).toBe(true);
    expect(work.reason.code).toBe("work_override");

    // …and a skip override on a pause day is still the override that decides,
    // not the pause.
    const skip = await decideDay({
      userId: "u1",
      manilaDate: "2026-08-12",
      deps: deps({
        loadOverride: async () => ({ kind: "skip", note: null }),
        loadSchedule: async () => paused(),
      }),
    });
    expect(skip.work).toBe(false);
    expect(skip.reason.code).toBe("skip_day");
  });

  it("1d. a user override beats a holiday", async () => {
    const d = await decideDay({
      userId: "u1",
      manilaDate: NINO,
      deps: deps({
        loadOverride: async () => ({ kind: "skip", note: null }),
        companyHolidays: () =>
          new Map<string, HolidayInfo>([
            [NINO, { name: "Company Day", type: "public", source: "override" }],
          ]),
      }),
    });
    expect(d.reason.code).toBe("skip_day");
  });
});

describe("decideDay — the regression cases", () => {
  it("2026-08-21 (optional) SKIPS", async () => {
    const d = await decideDay({ userId: "u1", manilaDate: NINO, deps: deps() });
    expect(d.work).toBe(false);
    expect(d.reason.code).toBe("holiday");
  });

  it("2026-08-25 (an observance) WORKS", async () => {
    const d = await decideDay({ userId: "u1", manilaDate: MAWLID, deps: deps() });
    expect(d.work).toBe(true);
    expect(d.reason.code).toBe("workday");
  });
});

describe("decideDay — it never throws", () => {
  it("a THROWN override read degrades to library+weekend, logging once", async () => {
    const d = await decideDay({
      userId: "u1",
      manilaDate: NINO,
      now: new Date("2026-08-21T05:30:00+08:00"),
      deps: deps({
        loadOverride: async () => {
          throw new Error("42P01 undefined_table");
        },
      }),
    });
    // The library answer survives the failed read.
    expect(d.work).toBe(false);
    expect(d.reason.code).toBe("holiday");
    expect(d.reason.holidayName).toBe("Ninoy Aquino Day");
    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it("a THROWN company-config read still decides from weekend + library", async () => {
    const inTheWay = await decideDay({
      userId: "u1",
      manilaDate: NINO,
      now: new Date("2026-08-21T05:30:00+08:00"),
      deps: deps({
        companyHolidays: () => {
          throw new Error('EXTRA_HOLIDAYS: entry 1 ("nope") is malformed');
        },
      }),
    });
    expect(inTheWay.work).toBe(false);
    expect(inTheWay.reason.code).toBe("holiday");

    const free = await decideDay({
      userId: "u1",
      manilaDate: MAWLID,
      now: new Date("2026-08-25T05:30:00+08:00"),
      deps: deps({
        companyHolidays: () => {
          throw new Error("malformed");
        },
      }),
    });
    expect(free.work).toBe(true);
  });

  it("a second degrade within the cooldown does not log again", async () => {
    const throwing = deps({
      loadOverride: async () => {
        throw new Error("boom");
      },
    });
    await decideDay({
      userId: "u1",
      manilaDate: "2026-08-11",
      now: new Date("2026-08-11T05:30:00+08:00"),
      deps: throwing,
    });
    await decideDay({
      userId: "u1",
      manilaDate: "2026-08-12",
      now: new Date("2026-08-11T05:31:00+08:00"),
      deps: throwing,
    });
    expect(warnMock).toHaveBeenCalledTimes(1);

    // Past the cooldown it logs again.
    await decideDay({
      userId: "u1",
      manilaDate: "2026-08-13",
      now: new Date("2026-08-11T07:00:00+08:00"),
      deps: throwing,
    });
    expect(warnMock).toHaveBeenCalledTimes(2);
  });
});

describe("decideRange", () => {
  it("decides every day in [from, to] and attaches the user's overrides", async () => {
    const days = await decideRange({
      userId: "u1",
      from: "2026-08-07",
      to: "2026-08-11",
      deps: deps({
        loadOverridesInRange: async () => [
          { manilaDate: "2026-08-11", kind: "skip", note: "leave" },
        ],
      }),
    });
    expect(days.map((d) => d.manilaDate)).toEqual([
      "2026-08-07",
      "2026-08-08",
      "2026-08-09",
      "2026-08-10",
      "2026-08-11",
    ]);
    expect(days[0]!.reason.code).toBe("workday"); // Friday
    expect(days[1]!.reason.code).toBe("weekend"); // Saturday
    expect(days[2]!.reason.code).toBe("weekend"); // Sunday
    expect(days[3]!.reason.code).toBe("workday"); // Monday
    expect(days[4]!.reason.code).toBe("skip_day"); // the override
    expect(days[4]!.override).toEqual({ kind: "skip", note: "leave" });
  });
});

describe("nextWorkday", () => {
  it("a Friday looks past the weekend to Monday", async () => {
    const next = await nextWorkday({ userId: "u1", from: NINO, deps: deps() });
    expect(next?.manilaDate).toBe("2026-08-24");
    expect(next?.work).toBe(true);
  });

  it("before a holiday Monday, the next workday is Tuesday", async () => {
    // 2026-08-28 is a Friday; Sat/Sun are the weekend and Mon 08-31 is National
    // Heroes' Day (public), so the next work day is Tue 2026-09-01.
    const next = await nextWorkday({
      userId: "u1",
      from: "2026-08-28",
      deps: deps(),
    });
    expect(next?.manilaDate).toBe("2026-09-01");
    expect(next?.work).toBe(true);
  });

  it("returns null when nothing in the search window is a workday", async () => {
    const never = deps({
      loadOverridesInRange: async (_userId, from, to) => {
        const rows: { manilaDate: string; kind: "skip" | "work"; note: string | null }[] =
          [];
        for (let d = from; d <= to; d = addManilaDays(d, 1)) {
          rows.push({ manilaDate: d, kind: "skip", note: null });
        }
        return rows;
      },
    });
    expect(
      await nextWorkday({ userId: "u1", from: NINO, maxDays: 5, deps: never }),
    ).toBeNull();
  });
});
