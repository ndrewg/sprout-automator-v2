/**
 * Format a run's calendar day for the history table. The clock is injected —
 * `now`, never `Date.now()` inside — so the formatter stays a pure function
 * (a formatter reading the wall clock becomes the next date time-bomb the way
 * missed-run-sweep's wall-clock filter did, BACKLOG § 11).
 *
 * Returns "Today" / "Yesterday" for the two most recent *local* calendar days,
 * otherwise a short weekday + day + month ("Wed 12 Aug"), with the year
 * appended only when it is not the current year.
 */
export function formatRunDate(
  iso: string,
  now: Date,
  locales?: string | string[],
): string {
  const date = new Date(iso);
  const startOfDay = (d: Date): Date =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate());
  // Math.round, not division alone: DST days are 23/25 hours long.
  const dayDiff = Math.round(
    (startOfDay(now).getTime() - startOfDay(date).getTime()) / 86_400_000,
  );
  if (dayDiff === 0) return "Today";
  if (dayDiff === 1) return "Yesterday";

  const options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    day: "numeric",
    month: "short",
  };
  if (date.getFullYear() !== now.getFullYear()) {
    options.year = "numeric";
  }
  // Assemble parts explicitly: the phase format is "Wed 12 Aug" (weekday, day,
  // month, then year) which no single Intl layout produces across locales.
  const parts = new Intl.DateTimeFormat(locales, options).formatToParts(date);
  const byType: Record<string, string | undefined> = Object.fromEntries(
    parts.map((p) => [p.type, p.value]),
  );
  return [byType["weekday"], byType["day"], byType["month"], byType["year"]]
    .filter(Boolean)
    .join(" ");
}
