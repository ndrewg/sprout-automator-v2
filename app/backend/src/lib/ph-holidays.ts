import Holidays from "date-holidays";

const hd = new Holidays("PH");

export type HolidayInfo = {
  name: string;
  type: string;
  source: "library" | "override" | "gazette";
};

/** Holiday types we treat as "skip the auto clock action". */
const SKIP_TYPES = new Set(["public", "bank", "optional"]);

/**
 * Returns details of the first Philippine holiday (interpreted in Asia/Manila)
 * whose type is one we skip the auto clock action for, or null otherwise.
 * The `type` lets callers tell a regular holiday (`public`) from a special
 * non-working day (`optional`) so they can branch on it — e.g. only notify on
 * the less-certain `optional` skips.
 *
 * This is the pure LIBRARY lookup only (phase 13). The EXTRA_HOLIDAYS overrides
 * and the Official Gazette cache are layered on top by services/holidays.ts,
 * which consults all three sources (override > library > gazette, gazette
 * additive-only). Keeping the library query here preserves `date-holidays`
 * module ownership (rule 9).
 */
export function isPhilippineHoliday(
  date: Date = new Date(),
): HolidayInfo | null {
  const hits = hd.isHoliday(date);
  if (Array.isArray(hits)) {
    const match = hits.find((h) => SKIP_TYPES.has(h.type));
    if (match) {
      return { name: match.name, type: match.type, source: "library" };
    }
  }
  return null;
}

/** Format `date` as `YYYY-MM-DD` in Asia/Manila. */
export function manilaDateString(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * True when `date` (a Manila calendar day) falls inside the inclusive pause
 * window. Both columns are set and cleared together; one without the other is
 * invalid input, treated here as "not paused". YYYY-MM-DD strings compare
 * correctly with <= / >= — no Date arithmetic, no timezone traps.
 */
export function isPausedOn(
  row: { pausedFrom: string | null; pausedUntil: string | null },
  date: Date = new Date(),
): boolean {
  if (!row.pausedFrom || !row.pausedUntil) return false;
  const today = manilaDateString(date);
  return today >= row.pausedFrom && today <= row.pausedUntil;
}
