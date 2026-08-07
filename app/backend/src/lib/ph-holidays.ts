import Holidays from "date-holidays";

const hd = new Holidays("PH");

/** Manual overrides for proclamation-only days the library hasn't picked up. */
const EXTRAS: Record<string, string> = {
  // "2026-02-17": "Chinese New Year",
};

/** Holiday types we treat as "skip the auto clock action". */
const SKIP_TYPES = new Set(["public", "bank"]);

/**
 * Returns the holiday name if the given date (interpreted in Asia/Manila) is
 * a Philippine public holiday, or null otherwise.
 */
export function isPhilippineHoliday(date: Date = new Date()): string | null {
  const iso = manilaDateString(date);
  if (EXTRAS[iso]) return EXTRAS[iso];

  const hits = hd.isHoliday(date);
  if (Array.isArray(hits)) {
    const match = hits.find((h) => SKIP_TYPES.has(h.type));
    if (match) return match.name;
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

export function isYearCovered(_date: Date = new Date()): boolean {
  return true;
}
