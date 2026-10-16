// The Playwright implementation of the HRHub portal seam (phase 17 § 17A).
//
// Everything HRHub-specific lives here: the browser, the per-user storage
// state, the login + OTP flow, the card's locator, and the clock action's
// selectors. The orchestration above the seam (clock-attempt.ts) sees only the
// five-method interface, which is what lets it be unit-tested with a scripted
// fake and no Chromium.
//
// `playwright` is still imported only under src/automation/ (AGENTS.md rule 9 /
// D5) — and now only in this file and `browser.ts`, both of which are on the
// Playwright side of the seam.

import type { Browser, BrowserContext, Page } from "playwright";
import { clearUserStorageState } from "../lib/paths";
import { manilaDateString } from "../services/workday";
import { parseAttendanceCard, type AttendanceCard } from "./attendance-card";
import {
  createUserContext,
  launchBrowser,
  saveUserStorageState,
} from "./browser";
import { performClockAction } from "./clock";
import { handleOtp, performLogin, type SproutCreds } from "./login";
import type {
  ClockAction,
  ClockPressResult,
  HRHubPortal,
  LoginMethod,
} from "./portal-seam";
import { isLoggedIn, isOnOtpPage, navigateToPortal } from "./portal";
import { screenshot } from "./screenshot";

export type PlaywrightPortalArgs = {
  userId: string;
  runId: string;
  creds: SproutCreds;
  waitForOtpCode: () => Promise<string>;
  log?: (message: string) => void;
};

export function createPlaywrightPortal(args: PlaywrightPortalArgs): HRHubPortal {
  const { userId, runId, creds, waitForOtpCode, log } = args;

  let browser: Browser | null = null;
  let contextRef: BrowserContext | null = null;
  let pageRef: Page | null = null;

  const requirePage = (): Page => {
    if (!pageRef) {
      throw new Error("HRHub portal: ensureLoggedIn() has not completed");
    }
    return pageRef;
  };

  const ensureLoggedIn = async (): Promise<LoginMethod> => {
    log?.("Initializing Playwright browser context...");
    const browserInstance = await launchBrowser();
    browser = browserInstance;

    log?.("Creating user browser session...");
    const { context } = await createUserContext(browserInstance, userId);
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    contextRef = context;
    pageRef = page;

    log?.("Navigating to Sprout portal...");
    await navigateToPortal(page, userId, runId);
    await screenshot(page, userId, runId, "initial-page");

    log?.("Checking active session status...");
    let loggedIn = await isLoggedIn(page);
    let loginMethod: LoginMethod = "saved_session";

    if (!loggedIn) {
      log?.("Session not found or expired. Attempting login...");
      if (await isOnOtpPage(page)) {
        log?.("Landed on OTP page directly. Using session OTP flow.");
        loginMethod = "session_otp";
      } else {
        log?.("Entering Sprout credentials...");
        await performLogin(page, creds, userId, runId, log);
        loginMethod = "fresh_login";
      }

      log?.("Handling login OTP validation...");
      const otpHandled = await handleOtp(page, waitForOtpCode, userId, runId, log);
      if (otpHandled) {
        loginMethod =
          loginMethod === "session_otp" ? "session_otp" : "fresh_login_with_otp";
      }

      await page.waitForTimeout(3000);
      loggedIn = await isLoggedIn(page);

      if (!loggedIn) {
        // The saved session was good enough for Sprout to show an OTP page but
        // not to complete a login, so the code was rejected and we were bounced
        // back to the login form. Retrying the OTP against that dead session can
        // never work — that is exactly how one stale storage-state.json became
        // five days of failures (2026-09-06..11). Throw the saved session away
        // and do a full credential login inside this same run.
        //
        // Cleared BEFORE the attempt, deliberately: if the recovery throws, the
        // underlying cause must propagate untouched — an OTP timeout is what the
        // user needs to see, not a generic "login failed" — and the next run
        // still starts from a clean slate either way.
        log?.(
          "Login verify failed. Discarding the saved session and logging in fresh...",
        );
        await clearUserStorageState(userId);
        await performLogin(page, creds, userId, runId, log);
        await handleOtp(page, waitForOtpCode, userId, runId, log);
        loginMethod = "fresh_login_with_otp";
        await page.waitForTimeout(3000);
        loggedIn = await isLoggedIn(page);
      }

      if (!loggedIn) {
        // A failed run never reaches saveUserStorageState, so without this the
        // file that broke this run survives to break the next one, and the one
        // after that. Clear it so the next run starts from a clean slate.
        await clearUserStorageState(userId);
        await screenshot(page, userId, runId, "login-failed");
        throw new Error(
          "Login failed — could not reach dashboard. Check screenshots.",
        );
      }

      log?.("Successfully authenticated. Reloading page to refresh ASP.NET tokens...");
      // Reload to refresh session tokens after OTP (stale ASP.NET tokens can
      // cause silent clock-action AJAX failures).
      await page.reload({ waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(2000);
      await screenshot(page, userId, runId, "post-login-reload");
    } else {
      log?.("Active session detected. Skipping login form.");
    }

    log?.("Saving browser storage state...");
    await saveUserStorageState(context, userId);
    return loginMethod;
  };

  /**
   * The card's text, or why it could not be read. The locator is the guard's
   * own, unchanged since phase 2: the Attendance title's nearest matching
   * ancestor in document order, which is the whole widget (its rows included).
   * Verified against the live markup 2026-10-14: the widget is
   * `div.widget` > `.widget-title` (title + clock dropdown) > `.widget-wrapper`
   * > `.widget-content` > `.widget-body` (the log table).
   */
  const readCardText = async (): Promise<
    { ok: true; text: string } | { ok: false; reason: string }
  > => {
    const page = requirePage();
    const attendanceSection = page
      .locator("text=Attendance")
      .locator(
        "xpath=ancestor::*[contains(@class,'card') or contains(@class,'Card') or contains(@class,'panel') or contains(@class,'widget') or contains(@class,'section')]",
      )
      .first();

    if (!(await attendanceSection.isVisible().catch(() => false))) {
      await screenshot(page, userId, runId, "attendance-card-not-found");
      return {
        ok: false,
        reason: "the Attendance card was not found on the dashboard",
      };
    }

    try {
      const text = await attendanceSection.innerText();
      await screenshot(page, userId, runId, "attendance-card-read");
      return { ok: true, text };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await screenshot(page, userId, runId, "attendance-card-read-error");
      return { ok: false, reason: `reading the card failed (${message})` };
    }
  };

  return {
    ensureLoggedIn,

    async readTodayAttendance(options): Promise<AttendanceCard> {
      const page = requirePage();
      const settleMs = options?.settleMs ?? 0;
      if (settleMs > 0) {
        // The AFTER read. HRHub does NOT repaint the Attendance widget after a
        // clock action: on 2026-10-15/16 the success dialog appeared, the
        // punch landed, and the card still showed the old rows seconds later,
        // so both live runs ended "unknown". Let the request settle, then
        // reload the dashboard — a plain GET of the page (the clock action is
        // AJAX, so nothing is resubmitted) — and read the fresh card.
        await page.waitForTimeout(settleMs);
        await page.reload({ waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
      }
      const card = await readCardText();
      if (!card.ok) {
        return {
          readable: false,
          inPresent: false,
          outPresent: false,
          inRow: null,
          outRow: null,
          unreadableReason: card.reason,
        };
      }
      return parseAttendanceCard(card.text, manilaDateString(new Date()));
    },

    async pressClockAction(action: ClockAction): Promise<ClockPressResult> {
      // performClockAction throws only BEFORE the confirmation click; see
      // clock.ts. The orchestration treats a throw as "nothing was dispatched".
      const result = await performClockAction(requirePage(), action, userId, runId, log);
      // The old runAutomation saved the storage state AGAIN after acting (HRHub
      // may have refreshed the session cookie during the clock request), and
      // only on the path that got past the click — a throw never reached it.
      // Same behaviour, same place: a save failure is logged, not thrown, so a
      // read-only disk cannot turn a landed clock into a failed run.
      if (contextRef) {
        log?.("Saving final browser storage state...");
        try {
          await saveUserStorageState(contextRef, userId);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          log?.(`Saving the storage state failed (${message}) — continuing.`);
        }
      }
      return result;
    },

    async takeScreenshot(name: string): Promise<void> {
      if (!pageRef) {
        log?.(`Screenshot ${name} skipped — no page yet.`);
        return;
      }
      // `screenshot` never throws (phase 17 § 17A); no try/catch needed here.
      await screenshot(pageRef, userId, runId, name);
    },

    async close(): Promise<void> {
      log?.("Closing browser context.");
      const instance = browser;
      browser = null;
      contextRef = null;
      pageRef = null;
      if (!instance) return;
      try {
        await instance.close();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log?.(`Closing the browser failed (${message}).`);
      }
    },
  };
}
