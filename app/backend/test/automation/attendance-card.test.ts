import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseAttendanceCard,
  parseRowDate,
} from "../../src/automation/attendance-card";

// Phase 17 § 17B's fixture tests, against SYNTHETIC card text.
//
// A row's line is what the real widget renders — the date, the mode label and
// the time, one line per row because Chromium separates table cells with a tab
// (captured from the live dashboard markup 2026-10-14: HRHub renders the date
// with its own `moment(LogTime).format('MM/DD/YY')`). Nothing here is employee
// data: no names, no IDs, just the date/mode/time shapes.
//
// REMAINING FOR THE OPERATOR: save a real (name- and ID-redacted) card snapshot
// under test/fixtures/ and add a test that parses it, so drift in HRHub's own
// markup is caught as well as drift in the date format.

const TODAY = "2026-08-10";

function row(date: string, mode: string, time: string): string {
  // Table cells render tab-separated on one line.
  return `${date}\t${mode}\t${time}`;
}

describe("parseRowDate", () => {
  it("parses the MM/DD/YY format HRHub actually renders", () => {
    expect(parseRowDate("08/10/26\tIN\t05:02 AM")).toBe("2026-08-10");
  });

  it("parses the unpadded M/D/YY variant", () => {
    expect(parseRowDate(row("8/1/26", "OUT", "06:01 PM"))).toBe("2026-08-01");
  });

  it("parses an ISO date", () => {
    expect(parseRowDate(row("2026-08-10", "IN", "05:02 AM"))).toBe("2026-08-10");
  });

  it("refuses a day-first date instead of misreading it as month 28", () => {
    // The drift case: this must be UNPARSEABLE, not silently 2026-28-05.
    expect(parseRowDate(row("28/05/2026", "IN", "05:02 AM"))).toBeNull();
  });

  it("refuses impossible months and days", () => {
    expect(parseRowDate("13/01/26")).toBeNull();
    expect(parseRowDate("08/32/26")).toBeNull();
  });

  it("refuses a line with no date at all", () => {
    expect(parseRowDate("Clock In/Out")).toBeNull();
    expect(parseRowDate("Attendance")).toBeNull();
  });
});

describe("parseAttendanceCard", () => {
  it("finds today's IN and OUT rows in the real row shape", () => {
    const card = [
      "Attendance",
      "Clock In/Out",
      row("08/10/26", "OUT", "06:01 PM"),
      row("08/10/26", "IN", "05:02 AM"),
    ].join("\n");

    const parsed = parseAttendanceCard(card, TODAY);

    expect(parsed.readable).toBe(true);
    expect(parsed.inPresent).toBe(true);
    expect(parsed.outPresent).toBe(true);
    expect(parsed.inRow).toBe(row("08/10/26", "IN", "05:02 AM"));
    expect(parsed.outRow).toBe(row("08/10/26", "OUT", "06:01 PM"));
    expect(parsed.unreadableReason).toBeNull();
  });

  it("is readable with only earlier days' rows, and reports nothing for today", () => {
    const card = [
      row("08/07/26", "OUT", "06:02 PM"),
      row("08/07/26", "IN", "05:29 AM"),
    ].join("\n");

    const parsed = parseAttendanceCard(card, TODAY);

    expect(parsed.readable).toBe(true);
    expect(parsed.inPresent).toBe(false);
    expect(parsed.outPresent).toBe(false);
  });

  it("is unreadable when no row's date is in a known format", () => {
    const card = [
      row("28/05/2026", "IN", "05:02 AM"),
      row("27/05/2026", "OUT", "06:01 PM"),
    ].join("\n");

    const parsed = parseAttendanceCard(card, TODAY);

    expect(parsed.readable).toBe(false);
    expect(parsed.inPresent).toBe(false);
    expect(parsed.outPresent).toBe(false);
    expect(parsed.unreadableReason).toContain("no row carried a date");
  });

  it("is unreadable when the card rendered no text", () => {
    const parsed = parseAttendanceCard("", TODAY);

    expect(parsed.readable).toBe(false);
    expect(parsed.unreadableReason).toContain("no text at all");
  });

  it("is unreadable for the widget's empty state — no dates means no evidence", () => {
    // The real widget renders this when its log list is empty (including when
    // the AJAX behind it failed), so it must NOT be read as "not clocked today":
    // proceeding would be the fail-open double clock phase 17 removes.
    const parsed = parseAttendanceCard("Attendance\nNo Current Logs", TODAY);

    expect(parsed.readable).toBe(false);
  });

  it("counts a BROKEN OT row as an IN/OUT row, as HRHub labels it", () => {
    // The widget renders "BROKEN OT - IN" in the same cell as "IN", so a
    // word-boundary match sees it. Documented, not accidental: it is still an
    // entry on today's record.
    const parsed = parseAttendanceCard(row("08/10/26", "BROKEN OT - IN", "07:31 PM"), TODAY);

    expect(parsed.readable).toBe(true);
    expect(parsed.inPresent).toBe(true);
  });

  it("does not count the dropdown's 'Clock In/Out' text as a row", () => {
    const parsed = parseAttendanceCard(
      ["Attendance", "Clock In/Out", "Clock In", "Clock Out"].join("\n"),
      TODAY,
    );

    // No dates at all → unreadable, never "not clocked today".
    expect(parsed.readable).toBe(false);
  });
});

describe("attendance card — real snapshot (2026-10-14)", () => {
  // The operator's real dashboard capture ("Webpage, Complete", 2026-10-14),
  // reduced to the Attendance widget's innerText and committed under
  // test/fixtures/. It carries only dates, IN/OUT labels and times — no names,
  // no employee IDs — which is what makes it safe to keep in the repo.
  //
  // Provenance: the fixture is the widget's *rendered* innerText as serialised
  // by the browser's "Webpage, Complete" save, read with JavaScript DISABLED.
  // That matters: HRHub renders this widget through Knockout, so re-executing
  // the page's own scripts against a dead backend resets the log list to its
  // empty state ("No Current Logs"). Read the capture; do not re-run it.
  //
  // Every line is trimmed before parsing, so trailing whitespace is not
  // load-bearing.
  const cardText = readFileSync(
    fileURLToPath(
      new URL("../fixtures/attendance-card-2026-10-14.txt", import.meta.url),
    ),
    "utf8",
  );

  it("parses the real card and finds today's IN and OUT rows", () => {
    const parsed = parseAttendanceCard(cardText, "2026-10-14");

    expect(parsed.readable).toBe(true);
    expect(parsed.unreadableReason).toBeNull();
    expect(parsed.inPresent).toBe(true);
    expect(parsed.outPresent).toBe(true);
    // The exact lines the widget rendered — date, mode and time, tab-separated.
    expect(parsed.inRow).toBe("10/14/26\tIN\t05:30 AM");
    expect(parsed.outRow).toBe("10/14/26\tOUT\t04:16 PM");
  });

  it("is readable on a later day but reports nothing for it — earlier rows never leak", () => {
    const parsed = parseAttendanceCard(cardText, "2026-10-15");

    expect(parsed.readable).toBe(true);
    expect(parsed.inPresent).toBe(false);
    expect(parsed.outPresent).toBe(false);
    expect(parsed.inRow).toBeNull();
    expect(parsed.outRow).toBeNull();
  });

  it("carries no names or IDs — every line is a known chrome label or the exact row shape", () => {
    // Deliberately STRICTER than the parser: `parseRowDate` is a substring match,
    // so a line that carried a name or an employee ID alongside a date would
    // still parse. This is a redaction guard on a committed fixture, so each line
    // must be a known chrome label or match the row shape exactly — a name/ID
    // line fails here and forces a re-check by eye.
    const chrome = new Set([
      "Attendance",
      "Clock In/Out",
      "Clock In",
      "Clock Out",
      "Show Team Attendance",
      "No Current Logs",
    ]);
    const rowShape =
      /^\d{2}\/\d{2}\/\d{2}\t(?:IN|OUT|BROKEN OT - IN|BROKEN OT - OUT)\t\d{2}:\d{2} (?:AM|PM)$/;
    const lines = cardText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const ok = chrome.has(line) || rowShape.test(line);
      expect(
        ok,
        `unexpected fixture line (possible unredacted data?): ${JSON.stringify(line)}`,
      ).toBe(true);
    }
  });
});
