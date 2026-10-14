import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { gazetteHolidays } from "../db/schema";
import { logger } from "../lib/logger";
import { manilaDateString } from "../lib/ph-holidays";
import { manilaHhmm, onTick } from "../lib/wall-clock-tick";
import {
  fetchGazetteProclamations,
  type GazetteEntry,
} from "../lib/gazette";

// The Official Gazette advisory layer's database + scheduling half (phase 13B).
// Fetching/parsing lives in lib/gazette.ts; the CACHE lives here. The scheduler
// reads this cache at decision time and makes NO network call — a cold or stale
// cache degrades to the library (services/holidays.ts) rather than blocking.

/**
 * Fetch proclamation holidays and UPSERT them into the cache. NON-FATAL: a
 * fetch that throws or hangs logs once, keeps the previous cache, and never
 * affects a run (hard rule 11). This is asserted by a test, not by intent.
 * The `fetchFn` transport is injectable for tests.
 */
export async function refreshGazetteCache(
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  try {
    const entries = await fetchGazetteProclamations(fetchFn);
    for (const e of entries) {
      await db
        .insert(gazetteHolidays)
        .values({
          manilaDate: e.date,
          name: e.name,
          scope: e.scope,
          proclamationNo: e.proclamationNo,
        })
        .onConflictDoUpdate({
          target: [gazetteHolidays.manilaDate, gazetteHolidays.name],
          set: {
            scope: e.scope,
            proclamationNo: e.proclamationNo,
            fetchedAt: new Date(),
          },
        });
    }
    logger.info({ count: entries.length }, "gazette cache refreshed");
  } catch (err: unknown) {
    // Non-fatal: keep the previous cache (rule 11). Logged once with the error
    // name only (a DOMException carries ~25 constants that bury the signal).
    logger.warn(
      { errName: err instanceof Error ? err.name : typeof err },
      "gazette refresh failed — keeping previous cache",
    );
  }
}

/**
 * Once-per-process flag for the degrade warning above: state that must not spam
 * a log file with the same failure on every tick.
 */
let gazetteReadWarned = false;

/**
 * Load the cached proclamation holidays for a single Manila calendar day.
 * This is the CACHE-FIRST read the scheduler uses at decision time — no
 * network. Returns [] when the cache is cold/empty for that day, and the caller
 * (services/holidays.ts) degrades to the library.
 *
 * Phase 15A: a read that THROWS also returns [] rather than propagating. An
 * unmigrated database (`42P01 undefined_table`) used to escape this function
 * and take out all four callers of `resolveHolidayDecision` — the cron fire, the
 * missed-run sweep, the retry gating and the dashboard's holiday display — so a
 * missing table broke the automation AND the alert that would have reported it.
 * A cache read is advisory: it may ADD a skip, never block one, and never block
 * a run. Logged once per process (a repeat of the same failure is not news).
 */
export async function loadGazetteForDate(
  dateStr: string,
): Promise<GazetteEntry[]> {
  try {
    const rows = await db
      .select()
      .from(gazetteHolidays)
      .where(eq(gazetteHolidays.manilaDate, dateStr));
    return rows.map((r) => ({
      date: r.manilaDate,
      name: r.name,
      scope: r.scope as GazetteEntry["scope"],
      proclamationNo: r.proclamationNo,
    }));
  } catch (err: unknown) {
    if (!gazetteReadWarned) {
      gazetteReadWarned = true;
      logger.warn(
        { errName: err instanceof Error ? err.name : typeof err },
        "gazette cache read failed — degrading to the library (this warning is logged once)",
      );
    }
    return [];
  }
}

const NIGHTLY_AT = "03:00"; // Manila wall time, before the 05:30 decision.

/**
 * Register the NIGHTLY Gazette refresh (03:00 Manila, before the 05:30
 * decision) and do an initial refresh at boot so a fresh container already has
 * a cache. Both are non-blocking: refreshGazetteCache never throws, and a slow
 * first fetch must not delay boot.
 */
export function startGazetteRefresh(): void {
  // The boot refresh counts as today's nightly one if boot is already past
  // 03:00; a boot before 03:00 still gets the 03:00 refresh.
  let lastNightlyDate: string | null =
    manilaHhmm(new Date()) >= NIGHTLY_AT ? manilaDateString(new Date()) : null;
  // Driven by the shared wall-clock tick, not a long timer (see D8): the first
  // tick at or after 03:00 Manila each day refreshes, however late it is.
  onTick("gazette", (now) => {
    const today = manilaDateString(now);
    if (lastNightlyDate === today || manilaHhmm(now) < NIGHTLY_AT) return;
    lastNightlyDate = today;
    void refreshGazetteCache();
  });
  logger.info(
    { at: NIGHTLY_AT, timezone: "Asia/Manila" },
    "gazette refresh registered",
  );
  void refreshGazetteCache();
}
