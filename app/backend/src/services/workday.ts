import { and, eq, gte, lte } from "drizzle-orm";
import { db } from "../db/client";
import { dayOverrides, schedules, type Schedule } from "../db/schema";
import { logger } from "../lib/logger";
import { isPhilippineHoliday, type HolidayInfo } from "../lib/ph-holidays";
import { resolveCompanyHoliday, companyHolidayOverrides } from "./holidays";

// The Workday gate (phase 16A, D9). ONE module answers the question that used
// to be answered in four places with four different ideas of "now" and of
// Manila time:
//
//     "should user U be clocked on Manila day D — and why?"
//
// Precedence, highest first (phase 16A contract):
//   1. the user's own day override (skip | work)   — `day_overrides`
//   2. pause range                                 — `schedules.paused_from/until`
//   3. weekend
//   4. company EXTRA_HOLIDAYS
//   5. library holiday of a skipping type          — public | bank | optional
//
// A user override beats a pause on that exact day: an explicit choice for a
// date is more specific than a range.
//
// NEVER THROWS. Any read error (the user's overrides, the pause window, the
// config) degrades to the library-plus-weekend answer, logs once per process
// with a cooldown, and the decision proceeds. This is old phase 15A's contract,
// designed in rather than patched on: an unmigrated database or a malformed
// config must never take out the scheduler fire, the retry gating, the
// missed-run sweep and the dashboard at once.
//
// It also OWNS the Manila clock helpers. Every other module imports them from
// here — there is one definition of "today in Manila", one weekend test, one
// wall-clock-slot instant and one HH:mm formatter. (Phase 16A removed the
// copies that had accumulated in `lib/ph-holidays.ts`, `lib/wall-clock-tick.ts`,
// `services/notifications.ts`, `services/retry.ts` and `services/holidays.ts`.)

// --- Manila clock helpers ----------------------------------------------------

const MANILA_DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Manila",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Format an instant as `YYYY-MM-DD` in Asia/Manila. */
export function manilaDateString(date: Date): string {
  return MANILA_DATE_FMT.format(date);
}

const MANILA_HHMM_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Manila",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** "HH:mm" in Asia/Manila for an instant. */
export function manilaHhmm(dt: Date): string {
  return MANILA_HHMM_FMT.format(dt);
}

/** YYYY-MM-DD -> a Date that is NOON in Manila on that calendar day (04:00Z). */
export function manilaNoon(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) {
    throw new Error(`manilaNoon: invalid Manila date "${dateStr}"`);
  }
  return new Date(Date.UTC(y, m - 1, d, 4));
}

/**
 * Add `delta` calendar days to a `YYYY-MM-DD` Manila date. Manila has no DST, so
 * noon + delta days is noon on the shifted day.
 */
export function addManilaDays(dateStr: string, delta: number): string {
  return manilaDateString(
    new Date(manilaNoon(dateStr).getTime() + delta * 86_400_000),
  );
}

const WEEKDAY_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Manila",
  weekday: "short",
});
const DAY_MONTH_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Manila",
  day: "numeric",
  month: "short",
});

/** "2026-08-21" -> "Fri 21 Aug"; "2026-11-02" -> "Mon 2 Nov". */
export function formatManilaDay(dateStr: string): string {
  const dt = manilaNoon(dateStr);
  return `${WEEKDAY_FMT.format(dt)} ${DAY_MONTH_FMT.format(dt)}`;
}

/** "YYYY-MM-DD" Manila date; true for Saturday/Sunday. */
export function isWeekend(dateStr: string): boolean {
  const [y, m, d] = dateStr.split("-").map(Number);
  const day = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  return day === 0 || day === 6;
}

/** The instant a schedule time (Manila wall clock) fires on `dateStr`. */
export function expectedFireTime(dateStr: string, timeStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [h, min] = timeStr.split(":").map(Number);
  if (!y || !m || !d || h === undefined || min === undefined) {
    throw new Error(`expectedFireTime: invalid date/time ${dateStr} ${timeStr}`);
  }
  // dateStr/timeStr are Asia/Manila wall time; Manila is UTC+8 year-round.
  return new Date(Date.UTC(y, m - 1, d, h, min) - 8 * 60 * 60 * 1000);
}

/**
 * True when `date` (a Manila calendar day) falls inside the inclusive pause
 * window. Both columns are set and cleared together; one without the other is
 * invalid input, treated here as "not paused". YYYY-MM-DD strings compare
 * correctly with <= / >= — no Date arithmetic, no timezone traps.
 */
export function isPausedOnDay(
  row: { pausedFrom: string | null; pausedUntil: string | null },
  manilaDate: string,
): boolean {
  if (!row.pausedFrom || !row.pausedUntil) return false;
  return manilaDate >= row.pausedFrom && manilaDate <= row.pausedUntil;
}

/** `isPausedOn` for a caller holding an instant rather than a Manila day. */
export function isPausedOn(
  row: { pausedFrom: string | null; pausedUntil: string | null },
  date: Date = new Date(),
): boolean {
  return isPausedOnDay(row, manilaDateString(date));
}

// --- The decision ------------------------------------------------------------

export type DayOverride = {
  kind: "skip" | "work";
  note: string | null;
};

export type WorkdayReasonCode =
  | "workday"
  | "weekend"
  | "paused"
  | "skip_day"
  | "work_override"
  | "holiday";

export type WorkdayReason = {
  code: WorkdayReasonCode;
  /** A short human phrase the UI and the notifications can drop into a sentence. */
  label: string;
  /** Present when `code === "holiday"`. */
  holidayName?: string;
  holidayType?: string;
  holidaySource?: "library" | "override";
  /** The user's free-text note on a day override, when there is one. */
  note?: string | null;
};

export type DayDecision = {
  /** YYYY-MM-DD Asia/Manila. */
  manilaDate: string;
  /** true = the user should be clocked on this day. */
  work: boolean;
  reason: WorkdayReason;
  /** The user's own override for this day, when one is set. */
  override: DayOverride | null;
};

/** Human label for a `date-holidays` type, used in reasons and messages. */
export function holidayTypeLabel(type: string): string {
  switch (type) {
    case "public":
      return "regular holiday";
    case "optional":
      return "special non-working";
    case "bank":
      return "bank holiday";
    default:
      return type;
  }
}

type LoadedDay = {
  override: DayOverride | undefined;
  schedule: Schedule | undefined;
  company: Map<string, HolidayInfo>;
  libraryHoliday: (date: Date) => HolidayInfo | null;
};

/**
 * The precedence ladder, over already-loaded data. Pure and synchronous: every
 * input that can fail has already been read (and degraded) by the caller.
 */
function decideFromLoaded(manilaDate: string, loaded: LoadedDay): DayDecision {
  const { override, schedule, company } = loaded;

  // 1. The user's own day override. Most specific thing there is.
  if (override) {
    const model = { kind: override.kind, note: override.note };
    if (override.kind === "skip") {
      return {
        manilaDate,
        work: false,
        reason: { code: "skip_day", label: "your skip day", note: override.note },
        override: model,
      };
    }
    return {
      manilaDate,
      work: true,
      reason: {
        code: "work_override",
        label: "you marked this as a workday",
        note: override.note,
      },
      override: model,
    };
  }

  // 2. The pause window (D18).
  if (schedule && isPausedOnDay(schedule, manilaDate)) {
    return {
      manilaDate,
      work: false,
      reason: { code: "paused", label: "your pause window" },
      override: null,
    };
  }

  // 3. Weekend.
  if (isWeekend(manilaDate)) {
    return {
      manilaDate,
      work: false,
      reason: { code: "weekend", label: "weekend" },
      override: null,
    };
  }

  // 4 + 5. A company holiday: operator override, else the library. A library
  // holiday is only a skip when its type is one we skip (public/bank/optional —
  // lib/ph-holidays.isPhilippineHoliday already applied that filter).
  const holiday = resolveCompanyHoliday(manilaDate, manilaNoon(manilaDate), company);
  if (holiday) {
    const typeLabel =
      holiday.source === "override" ? "company holiday" : holidayTypeLabel(holiday.type);
    return {
      manilaDate,
      work: false,
      reason: {
        code: "holiday",
        label: `${holiday.name} (${typeLabel})`,
        holidayName: holiday.name,
        holidayType: holiday.type,
        holidaySource: holiday.source,
      },
      override: null,
    };
  }

  // 6. Nothing in the way.
  return {
    manilaDate,
    work: true,
    reason: { code: "workday", label: "workday" },
    override: null,
  };
}

/** The library-plus-weekend answer, when a read failed and we must still decide. */
function degradedDecision(
  manilaDate: string,
  libraryHoliday: (date: Date) => HolidayInfo | null,
): DayDecision {
  if (!isWeekend(manilaDate)) {
    const holiday = libraryHoliday(manilaNoon(manilaDate));
    if (holiday) {
      return {
        manilaDate,
        work: false,
        reason: {
          code: "holiday",
          label: `${holiday.name} (${holidayTypeLabel(holiday.type)})`,
          holidayName: holiday.name,
          holidayType: holiday.type,
          holidaySource: holiday.source,
        },
        override: null,
      };
    }
  }
  if (isWeekend(manilaDate)) {
    return {
      manilaDate,
      work: false,
      reason: { code: "weekend", label: "weekend" },
      override: null,
    };
  }
  return {
    manilaDate,
    work: true,
    reason: { code: "workday", label: "workday" },
    override: null,
  };
}

// --- Degrade logging (once per process, with a cooldown) ---------------------

const DEGRADE_COOLDOWN_MS = 60 * 60 * 1000;
let lastDegradeLogAt: number | null = null;

function logDegrade(scope: string, err: unknown, now: Date): void {
  const at = now.getTime();
  if (lastDegradeLogAt !== null && at - lastDegradeLogAt < DEGRADE_COOLDOWN_MS) {
    return;
  }
  lastDegradeLogAt = at;
  logger.warn(
    {
      scope,
      errName: err instanceof Error ? err.name : typeof err,
    },
    "workday gate read failed — degrading to library+weekend (this warning is logged once per hour)",
  );
}

/** Test hook: forget the degrade-log cooldown. */
export function resetWorkdayGateWarnings(): void {
  lastDegradeLogAt = null;
}

// --- The gate ----------------------------------------------------------------

/**
 * The gate's collaborators. Injected so the tests drive the decision with no
 * database and no real clock, and so the degrade path (a throwing read) can be
 * exercised directly.
 */
export type WorkdayDeps = {
  loadOverride: (
    userId: string,
    manilaDate: string,
  ) => Promise<DayOverride | undefined>;
  loadOverridesInRange: (
    userId: string,
    from: string,
    to: string,
  ) => Promise<{ manilaDate: string; kind: "skip" | "work"; note: string | null }[]>;
  loadSchedule: (userId: string) => Promise<Schedule | undefined>;
  companyHolidays: () => Map<string, HolidayInfo>;
  libraryHoliday: (date: Date) => HolidayInfo | null;
};

export const defaultWorkdayDeps: WorkdayDeps = {
  loadOverride: async (userId, manilaDate) => {
    const [row] = await db
      .select()
      .from(dayOverrides)
      .where(
        and(
          eq(dayOverrides.userId, userId),
          eq(dayOverrides.manilaDate, manilaDate),
        ),
      )
      .limit(1);
    return row ? { kind: row.kind, note: row.note } : undefined;
  },
  loadOverridesInRange: async (userId, from, to) => {
    const rows = await db
      .select()
      .from(dayOverrides)
      .where(
        and(
          eq(dayOverrides.userId, userId),
          gte(dayOverrides.manilaDate, from),
          lte(dayOverrides.manilaDate, to),
        ),
      );
    return rows.map((r) => ({
      manilaDate: r.manilaDate,
      kind: r.kind,
      note: r.note,
    }));
  },
  loadSchedule: async (userId) => {
    const [row] = await db
      .select()
      .from(schedules)
      .where(eq(schedules.userId, userId))
      .limit(1);
    return row;
  },
  companyHolidays: companyHolidayOverrides,
  // `date-holidays` stays owned by lib/ph-holidays.ts (AGENTS.md rule 9); this
  // module only calls through it.
  libraryHoliday: isPhilippineHoliday,
};

function withWorkdayDeps(overrides: Partial<WorkdayDeps>): WorkdayDeps {
  return { ...defaultWorkdayDeps, ...overrides };
}

async function safeRead<T>(
  scope: string,
  read: () => Promise<T>,
  fallback: T,
  now: Date,
): Promise<T> {
  try {
    return await read();
  } catch (err: unknown) {
    logDegrade(scope, err, now);
    return fallback;
  }
}

export type DecideDayParams = {
  userId: string;
  /** YYYY-MM-DD Asia/Manila. */
  manilaDate: string;
  /** The instant the decision is being made (degrade-log cooldown). Defaults to now. */
  now?: Date;
  deps?: Partial<WorkdayDeps>;
};

/**
 * Decide one Manila day for one user. Never throws: any read failure degrades
 * to library-plus-weekend and the decision still comes back.
 */
export async function decideDay(params: DecideDayParams): Promise<DayDecision> {
  const d = withWorkdayDeps(params.deps ?? {});
  const at = params.now ?? new Date();
  const { userId, manilaDate } = params;

  const override = await safeRead<DayOverride | undefined>(
    "day_override",
    () => d.loadOverride(userId, manilaDate),
    undefined,
    at,
  );
  const schedule = await safeRead<Schedule | undefined>(
    "pause",
    () => d.loadSchedule(userId),
    undefined,
    at,
  );
  const company = await safeRead<Map<string, HolidayInfo>>(
    "config",
    async () => d.companyHolidays(),
    new Map<string, HolidayInfo>(),
    at,
  );

  try {
    return decideFromLoaded(manilaDate, {
      override,
      schedule,
      company,
      libraryHoliday: d.libraryHoliday,
    });
  } catch (err: unknown) {
    // Backstop: nothing above should throw, but a decision must always exist.
    logDegrade("decide", err, at);
    return degradedDecision(manilaDate, d.libraryHoliday);
  }
}

/**
 * Decide every day in `[from, to]` for one user, loading the overrides and the
 * schedule ONCE. This is what `GET /schedule/days` renders from — the frontend
 * never re-implements the gate.
 */
export async function decideRange(params: {
  userId: string;
  from: string;
  to: string;
  now?: Date;
  deps?: Partial<WorkdayDeps>;
}): Promise<DayDecision[]> {
  const d = withWorkdayDeps(params.deps ?? {});
  const at = params.now ?? new Date();
  const { userId, from, to } = params;

  const overrideRows = await safeRead(
    "day_overrides",
    () => d.loadOverridesInRange(userId, from, to),
    [] as { manilaDate: string; kind: "skip" | "work"; note: string | null }[],
    at,
  );
  const schedule = await safeRead<Schedule | undefined>(
    "pause",
    () => d.loadSchedule(userId),
    undefined,
    at,
  );
  const company = await safeRead<Map<string, HolidayInfo>>(
    "config",
    async () => d.companyHolidays(),
    new Map<string, HolidayInfo>(),
    at,
  );

  const byDate = new Map(overrideRows.map((r) => [r.manilaDate, r]));
  const out: DayDecision[] = [];
  for (let date = from; date <= to; date = addManilaDays(date, 1)) {
    const row = byDate.get(date);
    const override: DayOverride | undefined = row
      ? { kind: row.kind, note: row.note }
      : undefined;
    try {
      out.push(
        decideFromLoaded(date, {
          override,
          schedule,
          company,
          libraryHoliday: d.libraryHoliday,
        }),
      );
    } catch (err: unknown) {
      logDegrade("decide", err, at);
      out.push(degradedDecision(date, d.libraryHoliday));
    }
  }
  return out;
}

/**
 * The first work day strictly after `from`, searching at most `maxDays` ahead.
 * Used by the evening heads-up ("next clock-in is…") and by any caller that
 * needs to look past a weekend or a holiday.
 */
export async function nextWorkday(params: {
  userId: string;
  /** YYYY-MM-DD Asia/Manila — the search starts the day AFTER this one. */
  from: string;
  maxDays?: number;
  now?: Date;
  deps?: Partial<WorkdayDeps>;
}): Promise<DayDecision | null> {
  const maxDays = params.maxDays ?? 14;
  const start = addManilaDays(params.from, 1);
  const end = addManilaDays(params.from, maxDays);
  const decisions = await decideRange({
    userId: params.userId,
    from: start,
    to: end,
    now: params.now,
    deps: params.deps,
  });
  return decisions.find((d) => d.work) ?? null;
}
