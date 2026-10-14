// The attendance card, as structured data (phase 17 § 17A/17B).
//
// Deliberately PURE: card text in, structure out. The card's *markup* is
// HRHub's and stays in the Playwright adapter, but everything that decides
// "are we already clocked in?" is a pure function of the text the card renders
// — so it is unit-testable with no browser, and HRHub's date format is now
// under test instead of being buried in Playwright code (phase 17's evidence
// row 6: "every safety rule lives inside Playwright code; none of them is under
// test").
//
// What the card actually renders (captured from the real dashboard markup on
// 2026-10-14): a widget whose body is either an explicit empty state
// ("No Current Logs") or a table over the last 4 attendance logs. Each log is a
// row of [date][IN|OUT][time], and a row's innerText is ONE line —
// Chromium separates table cells with a tab, not a newline:
//
//     08/14/26\tIN\t05:30 AM
//
// The date comes from HRHub's own `moment(LogTime).format('MM/DD/YY')`, so
// MM/DD/YY is the format that matters; M/D/YY and ISO are kept because the
// guard has always accepted them and a format change must be *detected*, never
// silently mis-read.
//
// The accessibility trade this encodes (phase 17's point): a card we cannot
// parse means HRHub changed its format, and we must STOP rather than act. The
// old guard treated "no row matched" as "not clocked today" and proceeded —
// fail-open, with a double clock as the failure mode.

export type AttendanceCard = {
  /** The card was found and at least one of its rows carried a known date. */
  readable: boolean;
  /** Today's IN row is present. Meaningful only when `readable`. */
  inPresent: boolean;
  /** Today's OUT row is present. Meaningful only when `readable`. */
  outPresent: boolean;
  /** The card line that proves today's IN row, for the run message. */
  inRow: string | null;
  /** The card line that proves today's OUT row, for the run message. */
  outRow: string | null;
  /** Why the card is unreadable, when it is. Safe to log — never a secret. */
  unreadableReason: string | null;
};

// The three date formats the guard has always recognised. The verbatim tokens
// from the original guard (`\bIN\b` / `\bOUT\b`, CSS-free, case-sensitive) are
// kept: HRHub renders the mode as an UPPERCASE label in its own cell, and the
// lowercase words live only in the "Clock In/Out" dropdown, which is a
// different element on the same card.
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const SLASH_DATE = /\b(\d{1,2})\/(\d{1,2})\/(\d{2})\b/;
const IN_LABEL = /\bIN\b/;
const OUT_LABEL = /\bOUT\b/;

function isRealMonthDay(month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/**
 * The Manila day a card line is about, as `YYYY-MM-DD`, or null when the line
 * carries no date in a known format.
 *
 * A day-first format (`28/05/26`) is deliberately NOT parsed: month 28 is not a
 * month, which is what makes it unreadable rather than silently read as
 * 2026-28-05. Anything unrecognised returns null so the caller can tell
 * "HRHub changed its format" apart from "no row for today".
 */
export function parseRowDate(line: string): string | null {
  const iso = ISO_DATE.exec(line);
  if (iso) {
    const year = iso[1];
    const month = iso[2];
    const day = iso[3];
    if (year === undefined || month === undefined || day === undefined) return null;
    if (!isRealMonthDay(Number(month), Number(day))) return null;
    return `${year}-${month}-${day}`;
  }

  const slash = SLASH_DATE.exec(line);
  if (slash) {
    const month = slash[1];
    const day = slash[2];
    const shortYear = slash[3];
    if (month === undefined || day === undefined || shortYear === undefined) {
      return null;
    }
    if (!isRealMonthDay(Number(month), Number(day))) return null;
    // HRHub formats via moment's 'YY' — a two-digit year in the 2000s.
    return `20${shortYear.padStart(2, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  return null;
}

function unreadable(reason: string): AttendanceCard {
  return {
    readable: false,
    inPresent: false,
    outPresent: false,
    inRow: null,
    outRow: null,
    unreadableReason: reason,
  };
}

/**
 * Read the card's text into "is today's IN/OUT there?".
 *
 * Readable means: at least one line carried a date we can parse. That is the
 * signal that HRHub still renders dates the way we understand — it does NOT
 * mean anything about today. A card showing only earlier days is readable, and
 * "not clocked today" is a valid, correct answer (phase 17 § 17B).
 */
export function parseAttendanceCard(
  cardText: string,
  manilaToday: string,
): AttendanceCard {
  const lines = cardText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  let sawKnownDate = false;
  let inRow: string | null = null;
  let outRow: string | null = null;

  for (const line of lines) {
    const date = parseRowDate(line);
    if (date === null) continue;
    sawKnownDate = true;
    if (date !== manilaToday) continue;
    if (inRow === null && IN_LABEL.test(line)) inRow = line;
    if (outRow === null && OUT_LABEL.test(line)) outRow = line;
  }

  if (!sawKnownDate) {
    return unreadable(
      lines.length === 0
        ? "the card rendered no text at all"
        : "no row carried a date in a known format (MM/DD/YY, M/D/YY or YYYY-MM-DD)",
    );
  }

  return {
    readable: true,
    inPresent: inRow !== null,
    outPresent: outRow !== null,
    inRow,
    outRow,
    unreadableReason: null,
  };
}
