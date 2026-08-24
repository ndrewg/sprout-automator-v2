import cron from "node-cron";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { gazetteHolidays } from "../db/schema";
import { logger } from "../lib/logger";
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
 * Load the cached proclamation holidays for a single Manila calendar day.
 * This is the CACHE-FIRST read the scheduler uses at decision time — no
 * network. Returns [] when the cache is cold/empty for that day, and the caller
 * (services/holidays.ts) degrades to the library.
 */
export async function loadGazetteForDate(
  dateStr: string,
): Promise<GazetteEntry[]> {
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
}

/**
 * Register the NIGHTLY Gazette refresh (03:00 Manila, before the 05:30
 * decision) and do an initial refresh at boot so a fresh container already has
 * a cache. Both are non-blocking: refreshGazetteCache never throws, and a slow
 * first fetch must not delay boot.
 */
export function startGazetteRefresh(): void {
  cron.schedule("0 3 * * *", () => void refreshGazetteCache(), {
    timezone: "Asia/Manila",
  });
  logger.info(
    { expression: "0 3 * * *", timezone: "Asia/Manila" },
    "gazette refresh registered",
  );
  void refreshGazetteCache();
}
