import { describe, expect, it } from "vitest";
import { clockAttempt, ATTENDANCE_SETTLE_MS } from "../../src/automation/clock-attempt";
import {
  NO_CLOCK_IN_SKIP_REASON,
  shouldScheduleRetry,
  unknownOutcomeDetail,
} from "../../src/lib/run-outcome";
import { readableCard, scriptedPortal, unreadableCard } from "./fake-portal";

// Phase 17 § 17B — one test per row of the contract, driven by the scripted
// portal so no Chromium launches and no HRHub is ever touched.
//
// Each of these rules previously lived inside Playwright code that no test
// could reach (phase 17's evidence row 6: "every safety rule above lives inside
// Playwright code. Tests vi.mock the whole of runAutomation, so none of them is
// under test"). They are the rules that stand between the app and a double
// clock, and a clock-out with no clock-in.

const TODAY_IN_ROW = "08/10/26\tIN\t05:02 AM";
const TODAY_OUT_ROW = "08/10/26\tOUT\t06:01 PM";

describe("clockAttempt — reading the card before acting", () => {
  it("proceeds when the card is readable and shows no IN for today (earlier days only)", async () => {
    // "Not clocked today" is a valid answer, not an unreadable card. (That an
    // earlier-day row makes the card READABLE is the parser's test —
    // attendance-card.test.ts.)
    const portal = scriptedPortal({
      cards: [readableCard(), readableCard({ inPresent: true, inRow: TODAY_IN_ROW })],
      press: { outcome: "confirmed", message: "Time entry saved." },
    });

    const result = await clockAttempt(portal, { action: "in" });

    expect(portal.pressCount()).toBe(1);
    expect(portal.pressedActions).toEqual(["in"]);
    expect(result.outcome).toBe("success");
    expect(result.message).toBe("Time entry saved.");
  });

  it("skips an IN action when today's IN row is already on the card", async () => {
    const portal = scriptedPortal({
      cards: [readableCard({ inPresent: true, inRow: TODAY_IN_ROW })],
    });

    const result = await clockAttempt(portal, { action: "in" });

    expect(result.outcome).toBe("skipped");
    expect(result.skipReason).toContain("Already clocked IN today");
    expect(result.skipReason).toContain(TODAY_IN_ROW);
    // The double clock this guard exists to prevent: never press.
    expect(portal.pressCount()).toBe(0);
  });

  it("skips an OUT action when today's OUT row is already on the card", async () => {
    const portal = scriptedPortal({
      cards: [
        readableCard({ inPresent: true, outPresent: true, outRow: TODAY_OUT_ROW }),
      ],
    });

    const result = await clockAttempt(portal, { action: "out" });

    expect(result.outcome).toBe("skipped");
    expect(result.skipReason).toContain("Already clocked OUT today");
    expect(portal.pressCount()).toBe(0);
  });

  it("skips an OUT action when today has no IN — never a half record (and it alerts)", async () => {
    // The 2026-08-20 anomaly: the morning clock-in failed, the afternoon
    // clock-out succeeded, and an open shift was left on the day.
    const portal = scriptedPortal({ cards: [readableCard()] });

    const result = await clockAttempt(portal, { action: "out" });

    expect(result.outcome).toBe("skipped");
    expect(result.skipReason).toBe(NO_CLOCK_IN_SKIP_REASON);
    expect(portal.pressCount()).toBe(0);
  });

  it("skips when no row's date is in a known format — HRHub changed it (fail safe)", async () => {
    // Day-first is the classic drift: it must be UNREADABLE, never silently
    // read as 2026-28-05, and never treated as "not clocked today".
    const portal = scriptedPortal({
      cards: [
        readableCard({
          readable: false,
          unreadableReason:
            "no row carried a date in a known format (MM/DD/YY, M/D/YY or YYYY-MM-DD)",
        }),
      ],
    });

    const result = await clockAttempt(portal, { action: "in" });

    expect(result.outcome).toBe("skipped");
    expect(result.skipReason).toContain("Could not read the attendance card");
    expect(portal.pressCount()).toBe(0);
  });

  it("skips when there is no card at all, and an unreadable card is never read twice", async () => {
    const portal = scriptedPortal({ cards: [unreadableCard("no card")] });

    const result = await clockAttempt(portal, { action: "in" });

    expect(result.outcome).toBe("skipped");
    expect(portal.pressCount()).toBe(0);
    // Reading it again could not change the answer.
    expect(portal.readCount()).toBe(1);
  });

  it("treats a read that THROWS as unreadable rather than letting it kill the run", async () => {
    const portal = scriptedPortal();
    portal.readTodayAttendance = async () => {
      throw new Error("Execution context was destroyed");
    };

    const result = await clockAttempt(portal, { action: "in" });

    expect(result.outcome).toBe("skipped");
    expect(result.skipReason).toContain("Execution context was destroyed");
    expect(portal.pressCount()).toBe(0);
  });
});

describe("clockAttempt — verifying after the click", () => {
  it("succeeds when the row appears on the re-read, whatever the dialog said", async () => {
    // No dialog at all — the click may have been missed by HRHub's JS — but the
    // card's own record is the thing we trust.
    const portal = scriptedPortal({
      cards: [readableCard(), readableCard({ inPresent: true, inRow: TODAY_IN_ROW })],
      press: { outcome: "no_dialog" },
    });

    const result = await clockAttempt(portal, { action: "in" });

    expect(result.outcome).toBe("success");
    expect(portal.readCount()).toBe(2);
  });

  it("succeeds on the ROW even when HRHub showed its error dialog (the card wins)", async () => {
    const portal = scriptedPortal({
      cards: [
        readableCard({ inPresent: true, inRow: TODAY_IN_ROW }),
        readableCard({ inPresent: true, outPresent: true, outRow: TODAY_OUT_ROW }),
      ],
      press: { outcome: "error_dialog", error: "You are not currently clocked in." },
    });

    const result = await clockAttempt(portal, { action: "out" });

    expect(result.outcome).toBe("success");
  });

  it("is a retryable FAILURE when HRHub errored and the card shows no row", async () => {
    const portal = scriptedPortal({
      cards: [readableCard(), readableCard()],
      press: { outcome: "error_dialog", error: "Outside your scheduled shift." },
    });

    const result = await clockAttempt(portal, { action: "in" });

    expect(result.outcome).toBe("failure");
    expect(result.error).toBe("Outside your scheduled shift.");
    // Retryable: nothing was recorded, so the retry decision (phase 14) stands.
    expect(shouldScheduleRetry("failure", null)).toBe(true);
  });

  it("is a retryable FAILURE when the press fails before the confirmation click", async () => {
    const portal = scriptedPortal({
      cards: [readableCard()],
      press: new Error("Neither .dsk-btn nor .mbl-btn found in .clock-in-out-dropdown"),
    });

    const result = await clockAttempt(portal, { action: "in" });

    expect(result.outcome).toBe("failure");
    expect(result.error).toContain("Neither .dsk-btn nor .mbl-btn");
    // The card is never read again: nothing was dispatched.
    expect(portal.readCount()).toBe(1);
    expect(shouldScheduleRetry("failure", null)).toBe(true);
  });

  it("is UNKNOWN when nothing confirmed and no row appeared — and is never retried", async () => {
    const portal = scriptedPortal({
      cards: [readableCard(), readableCard()],
      press: { outcome: "no_dialog" },
    });

    const result = await clockAttempt(portal, { action: "in" });

    expect(result.outcome).toBe("unknown");
    expect(result.error).toBe(unknownOutcomeDetail());
    // The phase-15 lifecycle's decision, driven by the same predicate it uses:
    // an unknown failure must NOT queue a retry (the run is stored as
    // status='failure' + outcome='unknown').
    expect(shouldScheduleRetry("failure", "unknown")).toBe(false);
    expect(shouldScheduleRetry("failure", null)).toBe(true);
  });

  it("is UNKNOWN when the re-read cannot be read at all (no confirmation, no evidence)", async () => {
    const portal = scriptedPortal({
      cards: [
        readableCard({ inPresent: true, inRow: TODAY_IN_ROW }),
        unreadableCard("the Attendance card was not found"),
      ],
      press: { outcome: "confirmed", message: "Time entry saved." },
    });

    const result = await clockAttempt(portal, { action: "out" });

    // A confirmed dialog with an unreadable card is NOT success: the phase's
    // contract is that the row decides, and there is no row to decide with.
    expect(result.outcome).toBe("unknown");
  });
});

describe("clockAttempt — mechanics", () => {
  it("waits only before the AFTER read, then reads exactly twice", async () => {
    const portal = scriptedPortal({
      cards: [readableCard(), readableCard({ inPresent: true, inRow: TODAY_IN_ROW })],
      press: { outcome: "confirmed", message: null },
    });

    await clockAttempt(portal, { action: "in" });

    expect(portal.settleWaits).toEqual([0, ATTENDANCE_SETTLE_MS]);
  });

  it("keeps an explicit settleMs override (the settle is injectable for tests)", async () => {
    const portal = scriptedPortal({
      cards: [readableCard(), readableCard({ inPresent: true, inRow: TODAY_IN_ROW })],
    });

    await clockAttempt(portal, { action: "in" }, { settleMs: 1 });

    expect(portal.settleWaits).toEqual([0, 1]);
  });

  it("a screenshot failure never fails the run (17A)", async () => {
    const portal = scriptedPortal({
      cards: [readableCard(), readableCard({ inPresent: true, inRow: TODAY_IN_ROW })],
      press: { outcome: "no_dialog" },
      screenshotError: new Error("ENOSPC: no space left on device"),
    });

    const result = await clockAttempt(portal, { action: "in" });

    expect(result.outcome).toBe("success");
  });

  it("reports the login method from the portal, and lets a login failure throw", async () => {
    const ok = scriptedPortal({ loginMethod: "fresh_login_with_otp" });
    expect((await clockAttempt(ok, { action: "in" })).loginMethod).toBe(
      "fresh_login_with_otp",
    );

    const bad = scriptedPortal({
      loginError: new Error("Login failed — could not reach dashboard. Check screenshots."),
    });
    await expect(clockAttempt(bad, { action: "in" })).rejects.toThrow(
      "Login failed — could not reach dashboard",
    );
  });

  it("logs each decision so a run's steps explain themselves", async () => {
    const lines: string[] = [];
    const portal = scriptedPortal({ cards: [readableCard({ inPresent: true, inRow: TODAY_IN_ROW })] });

    await clockAttempt(portal, { action: "in", log: (m) => lines.push(m) });

    expect(lines.some((l) => l.includes("Reading the attendance card before acting"))).toBe(true);
    expect(lines.some((l) => l.includes("Already clocked IN today"))).toBe(true);
  });
});
