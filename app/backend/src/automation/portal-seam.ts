import type { AttendanceCard } from "./attendance-card";

// The HRHub portal seam (phase 17 § 17A, D19's 2026-10-14 refinement).
//
// The *selectors* against HRHub stay untestable — they run against a third
// party we cannot stage, and a fixture only proves the code matches our belief
// about HRHub (reference/testing-strategy.md). The *safety decisions* do not
// have to be, and until this phase they were: "read the card first", "read it
// again after", "an OUT needs today's IN", "unconfirmed means unknown" all
// lived inside Playwright code, and every test mocked the whole of
// `runAutomation`, so none of them had a test at all.
//
// So the seam is narrow on purpose: five methods, none of which knows anything
// about what a clock attempt should DO. Two adapters implement it —
// `playwright-portal.ts` against the real HRHub, and a scripted fake in the
// tests — which is what makes the orchestration above it (clock-attempt.ts)
// ordinary, testable code.
//
// What deliberately stays INSIDE the Playwright adapter: the browser launch,
// the per-user storage-state file, the OTP callback, every selector, and the
// screenshot at each step. None of that is a decision the orchestration needs
// to make, and moving it above the seam would put Chromium back in the tests.

export type ClockAction = "in" | "out";

/**
 * How the session got to the dashboard (the `runs.login_method` column).
 *
 * - `saved_session`        — the stored storage-state was still valid.
 * - `fresh_login`          — credentials filled, no OTP challenge.
 * - `fresh_login_with_otp` — credentials filled and an OTP was completed.
 * - `session_otp`          — landed straight on an OTP page (half-alive
 *                            session) and completed the OTP.
 */
export type LoginMethod =
  | "saved_session"
  | "fresh_login"
  | "fresh_login_with_otp"
  | "session_otp";

/**
 * What happened when the action was pressed.
 *
 * The boundary that matters is the confirmation click:
 *
 *   - a THROW means the action was never dispatched (a selector missed, a
 *     dialog never appeared, HRHub went down) — safe to retry;
 *   - `confirmed`    — HRHub's own success dialog appeared;
 *   - `error_dialog` — HRHub rendered its explicit error dialog instead;
 *   - `no_dialog`    — the click was dispatched and nothing came back, so
 *                      whether it landed is unknown.
 *
 * Neither `confirmed` nor `error_dialog` is trusted on its own: the
 * orchestration re-reads the attendance card and lets the ROW decide (§ 17B).
 */
export type ClockPressResult =
  | { outcome: "confirmed"; message: string | null }
  | { outcome: "error_dialog"; error: string }
  | { outcome: "no_dialog" };

export type HRHubPortal = {
  /**
   * Navigate and log in as needed, and return how it happened. Throws when the
   * dashboard could not be reached — the thrown message is what the user sees
   * ("Login failed — could not reach dashboard"), so it stays specific.
   *
   * The saved session file, the fresh-login recovery that discards a poisoned
   * one, and the OTP callback all stay inside the adapter.
   */
  ensureLoggedIn(): Promise<LoginMethod>;

  /**
   * Read today's attendance card.
   *
   * `settleMs` marks the AFTER-action read: wait that long for the click's
   * request to land, then reload the dashboard before reading, because HRHub
   * does not repaint the widget itself after a clock action. Never throws for a missing card: an unreadable card is data
   * (`readable: false`), because "we could not read it" is a decision the
   * orchestration makes, not an exception it catches.
   */
  readTodayAttendance(options?: { settleMs?: number }): Promise<AttendanceCard>;

  /**
   * Press the clock action. Throws when it fails BEFORE the confirmation
   * click; otherwise returns what HRHub showed (see `ClockPressResult`).
   */
  pressClockAction(action: ClockAction): Promise<ClockPressResult>;

  /**
   * Best-effort screenshot. An I/O failure is logged, never thrown: screenshots
   * are the only post-mortem signal for HRHub drift, but they must never cost a
   * run its clock.
   */
  takeScreenshot(name: string): Promise<void>;

  /** Release the browser. Never throws. */
  close(): Promise<void>;
};
