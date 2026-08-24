import type { HolidayInfo } from "./ph-holidays";

// EXTRA_HOLIDAYS (phase 13A) — operator-provided holidays the bundled dataset
// can't know about, without an image rebuild. A comma-separated list of
// `YYYY-MM-DD=Name` entries.
//
// Mirrors the signup-allowlist / trusted-peers "parse, validate, and REFUSE to
// boot on a malformed entry" stance (config.ts calls this at boot): a
// silently-dropped entry is a holiday that does not skip — the exact bug this
// phase exists to eliminate. An unset or empty value is exactly today's
// behaviour (no overrides).
//
// Deliberately does NOT import config (config.ts imports this parser for boot
// validation, so a back-import would be circular). Callers pass the raw string
// — production passes config.EXTRA_HOLIDAYS; tests pass an env override.

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parses the EXTRA_HOLIDAYS list into a Map keyed by YYYY-MM-DD. Throws on a
 * malformed entry, naming its 1-based position and the fix — never returns a
 * map that silently drops a bad entry. `undefined` (unset) or an entry-less
 * string returns an empty map.
 */
export function parseExtraHolidays(
  raw: string | undefined,
): Map<string, HolidayInfo> {
  const map = new Map<string, HolidayInfo>();
  if (raw === undefined) return map;
  const parts = raw.split(",");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!.trim();
    if (entry === "") continue;
    const eq = entry.indexOf("=");
    if (eq === -1) {
      throw invalidEntry(
        i + 1,
        entry,
        `missing a "=" — expected YYYY-MM-DD=Name, e.g. "2026-11-20=Some Holiday"`,
      );
    }
    const dateText = entry.slice(0, eq).trim();
    const name = entry.slice(eq + 1).trim();
    if (name === "") {
      throw invalidEntry(
        i + 1,
        entry,
        'has an empty name — expected YYYY-MM-DD=Name, e.g. "2026-11-20=Some Holiday"',
      );
    }
    if (!isRealCalendarDate(dateText)) {
      throw invalidEntry(
        i + 1,
        entry,
        `"${sanitize(dateText)}" is not a real calendar date — expected YYYY-MM-DD (e.g. 2026-11-20, and 2026-02-31 would be rejected)`,
      );
    }
    // Type "public" (a declared holiday). source "override" is what makes the
    // notify path always fire for a human-typed entry (13A).
    map.set(dateText, { name, type: "public", source: "override" });
  }
  return map;
}

/** True only for a REAL calendar date — "2026-02-31" is rejected, not just the
 *  `\d{4}-\d{2}-\d{2}` shape. */
function isRealCalendarDate(dateText: string): boolean {
  const m = DATE_RE.exec(dateText);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return false;
  // Day 0 of the next month is the last day of this month — a real check that
  // handles leap years (2028-02-29 is valid, 2026-02-29 is not).
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

/** Cap length first (so no escape sequence is cut in half), then escape control
 *  characters via JSON.stringify so the refusal reads as ONE line naming the
 *  offending value. Same approach as trusted-peers. */
function sanitize(entry: string, maxLength = 60): string {
  const capped =
    entry.length > maxLength ? `${entry.slice(0, maxLength)}…` : entry;
  return JSON.stringify(capped).slice(1, -1);
}

function invalidEntry(position: number, entry: string, reason: string): Error {
  return new Error(
    `entry ${position} ("${sanitize(entry)}") ${reason}. Use a comma-separated ` +
      `list of YYYY-MM-DD=Name entries`,
  );
}
