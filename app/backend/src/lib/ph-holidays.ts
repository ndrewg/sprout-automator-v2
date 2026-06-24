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

export function isYearCovered(_date: Date = new Date()): boolean {
  return true;
}
