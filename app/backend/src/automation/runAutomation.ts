import {
  createUserContext,
  launchBrowser,
  saveUserStorageState,
} from "./browser";
import {
  isAlreadyClockedForToday,
  performClockAction,
  type ClockAction,
} from "./clock";
import { handleOtp, performLogin, type SproutCreds } from "./login";
import { isLoggedIn, isOnOtpPage, navigateToPortal } from "./portal";
import { screenshot } from "./screenshot";

export type LoginMethod =
  | "saved_session"
  | "fresh_login"
  | "fresh_login_with_otp"
  | "session_otp";

export type AutomationResult = {
  success: boolean;
  skipped: boolean;
  loginMethod: LoginMethod;
  message?: string;
  error?: string;
  /** Why the run was skipped (from isAlreadyClockedForToday), for the notifier. */
  skipReason?: string;
};

export type RunArgs = {
  userId: string;
  runId: string;
  action: ClockAction;
  creds: SproutCreds;
  waitForOtpCode: () => Promise<string>;
  log?: (message: string) => void;
};

export async function runAutomation(args: RunArgs): Promise<AutomationResult> {
  const { userId, runId, action, creds, waitForOtpCode, log } = args;
  log?.("Initializing Playwright browser context...");
  const browser = await launchBrowser();
  try {
    log?.("Creating user browser session...");
    const { context } = await createUserContext(browser, userId);
    const page = await context.newPage();
    page.setDefaultTimeout(30000);

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
        log?.("Login verify failed. Retrying OTP form submission...");
        const otpAgain = await handleOtp(page, waitForOtpCode, userId, runId, log);
        if (otpAgain) {
          loginMethod = "fresh_login_with_otp";
          await page.waitForTimeout(3000);
          loggedIn = await isLoggedIn(page);
        }
      }

      if (!loggedIn) {
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

    log?.("Checking if already clocked for today...");
    const alreadyClocked = await isAlreadyClockedForToday(
      page,
      action,
      userId,
      runId,
      log,
    );
    if (alreadyClocked.skipped) {
      return {
        success: true,
        skipped: true,
        loginMethod,
        skipReason: alreadyClocked.reason,
      };
    }

    log?.(`Executing clock ${action.toUpperCase()} action...`);
    const result = await performClockAction(page, action, userId, runId, log);
    log?.("Saving final browser storage state...");
    await saveUserStorageState(context, userId);
    return {
      success: result.success,
      skipped: false,
      loginMethod,
      ...(result.message !== undefined ? { message: result.message } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  } finally {
    log?.("Closing browser context.");
    await browser.close().catch(() => {});
  }
}
