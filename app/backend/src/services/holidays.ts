import { config } from "../config";
import { parseExtraHolidays } from "../lib/extra-holidays";
import {
  isPhilippineHoliday,
  manilaDateString,
  type HolidayInfo,
} from "../lib/ph-holidays";
import type { GazetteEntry } from "../lib/gazette";
import { loadGazetteForDate } from "./gazette";

// The holiday ORCHESTRATOR (phase 13). The single place that consults ALL THREE
// sources when deciding whether a Manila day is a holiday the scheduler must
// skip:
//   - the bundled library (date-holidays, via lib/ph-holidays.ts) — `library`
//   - operator overrides (EXTRA_HOLIDAYS config)             — `override`
//   - the Official Gazette cache (services/gazette.ts)       — `gazette`
//
// Merge rules (the load-bearing part):
//   - Override > library for the same date, and always skip + notify.
//   - Gazette is ADDITIVE-ONLY: it can ADD a skip but NEVER cancel a library or
//     override skip. So a library skip wins over a same-date gazette entry.
//   - Only a NATIONAL gazette entry may add a skip. A regional/ambiguous entry
//     NOTIFIES as a possible holiday but does NOT skip (fail-safe: "ask the
//     human").
//   - CACHE-FIRST: reading the gazette is a DB read, never a network call.
//
// This is async because the gazette cache lives in the database.

export type HolidayDecision = {
  /** The holiday that justifies a SKIP, if any. When non-null, the scheduler
   *  skips the auto clock action and notifies. */
  skip: HolidayInfo | null;
  /** A "possible" holiday to NOTIFY about but NOT skip on (regional/ambiguous
   *  gazette). The scheduler still runs; the human decides. */
  possible: HolidayInfo | null;
  /** When the Gazette's date for a lunar holiday disagrees with the library's
   *  computed date, this carries the human-readable disagreement (e.g. "the
   *  bundled calendar placed Eid'l Fitr on 2026-03-20"). The library's answer
   *  is NOT rewritten — the point is the human learns they differ. */
  disagreementNote: string | null;
};

// EXTRA_HOLIDAYS source of truth: process.env wins (so tests can set it at
// runtime without re-loading config), else the boot-validated config value.
// Same env-override + config-fallback pattern as lib/heartbeat.ts.
function extraHolidaysRaw(): string | undefined {
  const override = process.env["EXTRA_HOLIDAYS"];
  if (override !== undefined && override !== "") return override;
  return config.EXTRA_HOLIDAYS;
}

export async function resolveHolidayDecision(date: Date): Promise<HolidayDecision> {
  const dateStr = manilaDateString(date);
  const overrides = parseExtraHolidays(extraHolidaysRaw());
  const gazette = await loadGazetteForDate(dateStr);

  // 1. Operator override always wins over the library for the same date, and
  //    always skips + notifies (a human typed it — 13A).
  const override = overrides.get(dateStr);
  if (override) {
    return { skip: override, possible: null, disagreementNote: null };
  }

  const library = isPhilippineHoliday(date);
  const national = gazette.find((g) => g.scope === "national") ?? null;
  const nonNational = gazette.find((g) => g.scope !== "national") ?? null;

  // 2. Gazette is additive-only: it can never cancel a library skip, so a
  //    library holiday on this date IS the skip.
  if (library) {
    return {
      skip: library,
      possible: null,
      disagreementNote: national
        ? disagreementFor(national, library, dateStr)
        : null,
    };
  }

  // 3. No library holiday: a NATIONAL gazette proclamation ADDS a skip.
  if (national) {
    return {
      skip: { name: national.name, type: "public", source: "gazette" },
      possible: null,
      disagreementNote: disagreementFor(national, library, dateStr),
    };
  }

  // 4. No skip at all: a regional/ambiguous gazette entry is a "possible"
  //    holiday — notify so the human decides, but do NOT skip (the scheduler
  //    still runs).
  if (nonNational) {
    return {
      skip: null,
      possible: { name: nonNational.name, type: "optional", source: "gazette" },
      disagreementNote: null,
    };
  }

  return { skip: null, possible: null, disagreementNote: null };
}

/**
 * When a NATIONAL gazette entry's name matches a library holiday on a DIFFERENT
 * date, the library's date looks wrong (the lunar/Eid payoff): report the
 * disagreement. Returns null when they agree on this date or there is no
 * library match elsewhere.
 */
function disagreementFor(
  national: GazetteEntry,
  libraryOnThisDate: HolidayInfo | null,
  dateStr: string,
): string | null {
  // If the library already agrees with the gazette ON this date, no conflict.
  if (
    libraryOnThisDate &&
    namesMatch(national.name, libraryOnThisDate.name)
  ) {
    return null;
  }
  // Probe a window around the gazette date (Eid differs by ±1 day) for a
  // same-named library holiday on a different date.
  for (let off = 1; off <= 5; off++) {
    const before = addDays(dateStr, -off);
    const libBefore = isPhilippineHoliday(noonManila(before));
    if (libBefore && namesMatch(national.name, libBefore.name)) {
      return (
        `The bundled calendar placed ${national.name} on ${before}, but the ` +
        `Official Gazette proclaims ${dateStr}. The library's date looks wrong.`
      );
    }
    const after = addDays(dateStr, off);
    const libAfter = isPhilippineHoliday(noonManila(after));
    if (libAfter && namesMatch(national.name, libAfter.name)) {
      return (
        `The bundled calendar placed ${national.name} on ${after}, but the ` +
        `Official Gazette proclaims ${dateStr}. The library's date looks wrong.`
      );
    }
  }
  return null;
}

// The significant word tokens of a holiday name, for loose matching: lowercased,
// apostrophes removed, split on non-alphanumerics, and generic words dropped.
// So "End of Ramadan (Eid al-Fitr)" -> {end, ramadan, eid, fitr} and "Eid'l
// Fitr" -> {eid, fitr}.
const NAME_STOPWORDS = new Set(["day", "the", "and", "of", "a", "for", "in", "on", "as", "an"]);
function nameTokens(name: string): Set<string> {
  const tokens = new Set<string>();
  // Apostrophe -> space (so "Eid'l Fitr" tokenises to {eid, fitr}, not {eidl,
  // fitr}), then split on non-alphanumerics.
  for (const token of name.toLowerCase().replace(/['’]/g, " ").split(/[^a-z0-9]+/)) {
    if (token.length >= 3 && !NAME_STOPWORDS.has(token)) tokens.add(token);
  }
  return tokens;
}

/** Loose name match for the disagreement check: exact (after normalising) or a
 *  shared core of >=2 significant tokens (so the library's "End of Ramadan
 *  (Eid al-Fitr)" matches the Gazette's "Eid'l Fitr"). */
function namesMatch(a: string, b: string): boolean {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  let shared = 0;
  for (const t of ta) {
    if (tb.has(t)) shared++;
  }
  return shared >= 2;
}

/** YYYY-MM-DD -> a Date that is NOON in Manila on that calendar day (04:00Z). */
function noonManila(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, 4));
}

/** Add `delta` calendar days to a YYYY-MM-DD Manila date (no DST in Manila, so
 *  noon + delta days is noon on the shifted day). */
function addDays(dateStr: string, delta: number): string {
  return manilaDateString(
    new Date(noonManila(dateStr).getTime() + delta * 86_400_000),
  );
}
