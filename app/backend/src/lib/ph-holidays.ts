import Holidays from "date-holidays";

const hd = new Holidays("PH");

export type HolidayInfo = {
  name: string;
  type: string;
  /**
   * Where the entry came from: the bundled library, or an operator
   * EXTRA_HOLIDAYS override. Phase 16 dropped the third (proclamation-feed)
   * source along with the Official Gazette layer — the government site sits
   * behind a Cloudflare bot challenge and its cache table never held a row.
   */
  source: "library" | "override";
};

/** Holiday types we treat as "skip the auto clock action". */
const SKIP_TYPES = new Set(["public", "bank", "optional"]);

/**
 * Returns details of the first Philippine holiday (interpreted in Asia/Manila)
 * whose type is one we skip the auto clock action for, or null otherwise.
 * The `type` lets callers tell a regular holiday (`public`) from a special
 * non-working day (`optional`) so they can branch on it — e.g. to render the
 * right label in a notification.
 *
 * This is the pure LIBRARY lookup only. The operator `EXTRA_HOLIDAYS` overrides
 * are layered on top by `services/holidays.ts`, and the whole decision (user
 * day override > pause > weekend > override > library) is owned by
 * `services/workday.ts`. Keeping the library query here preserves
 * `date-holidays` module ownership (AGENTS.md rule 9).
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
