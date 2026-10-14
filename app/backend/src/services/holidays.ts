import { config } from "../config";
import { parseExtraHolidays } from "../lib/extra-holidays";
import { isPhilippineHoliday, type HolidayInfo } from "../lib/ph-holidays";

// The COMPANY-WIDE holiday layer (phase 16). Two sources, in precedence order:
//
//   - operator overrides (EXTRA_HOLIDAYS config)  — `override`, always wins
//   - the bundled library (date-holidays)         — `library`
//
// The Official Gazette layer (phase 13B) was REMOVED in phase 16A: the
// government proclamation site sits behind a Cloudflare bot challenge (403
// "Just a moment…", confirmed 2026-10-14 with browser-like headers too), its
// cache table never held a row, and it was dead weight that looked like
// coverage. The human is the cross-check instead — through the day calendar and
// the evening heads-up.
//
// This module is deliberately THROW-FREE-adjacent and synchronous: it does no
// database work and no network work. The gate (`services/workday.ts`) owns the
// per-user question and catches anything this throws (a malformed
// EXTRA_HOLIDAYS in a test, say) so a decision never dies on a config read.

// EXTRA_HOLIDAYS source of truth: process.env wins (so tests can set it at
// runtime without re-loading config), else the boot-validated config value.
// Same env-override + config-fallback pattern as lib/heartbeat.ts.
function extraHolidaysRaw(): string | undefined {
  const override = process.env["EXTRA_HOLIDAYS"];
  if (override !== undefined && override !== "") return override;
  return config.EXTRA_HOLIDAYS;
}

/**
 * The operator's company-wide holiday overrides, parsed. Throws on a malformed
 * EXTRA_HOLIDAYS entry (the boot validation in config.ts is the production
 * guard; this throw is what the gate degrades on). Never call this in a path
 * that cannot handle a throw — call `workday` instead.
 */
export function companyHolidayOverrides(): Map<string, HolidayInfo> {
  return parseExtraHolidays(extraHolidaysRaw());
}

/**
 * The company-wide holiday for one Manila day, or null: the operator override
 * wins over the library for the same date, exactly as phase 13A specified.
 * A PER-USER day override is handled by the gate, above this.
 */
export function resolveCompanyHoliday(
  manilaDate: string,
  date: Date,
  overrides: Map<string, HolidayInfo>,
): HolidayInfo | null {
  return overrides.get(manilaDate) ?? isPhilippineHoliday(date);
}
