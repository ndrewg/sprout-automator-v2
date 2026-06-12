# Reference — HRHub Automation Playbook

This is the most brittle, highest-value code in the project. Every selector and timing here was learned by watching real runs fail. **The LLM must reproduce these modules verbatim** and must not "tidy up" selectors, swap CSS classes for text matching, or change the viewport. Attach to **Phase 2**.

---

## The non-negotiable HRHub invariants

1. **Viewport is 1920×1080.** Below ~1350px CSS width, HRHub's clock dropdown collapses to an icon-only button and the menu items become hidden `<span>`s. The 4-step clock action breaks silently. Always create the context at 1920×1080.
2. **CSS-class selectors, never text.** Use `.dsk-btn`, `.our-button`, `.btn-primary`, `.clock-in-dialog`, `.clock-out-dialog`, `.clock-in-out-dropdown`. Do **not** use `getByText("Clock In/Out")` — at certain viewports the text exists in the DOM but is `display:none`, so a text locator matches an invisible element and the click no-ops.
3. **Clock-in and clock-out have DIFFERENT success-dialog titles.** Clock-in success title = **"Time Entry Confirmation"**. Clock-out success title = **"Clocking Status Update"**. A single shared title selector breaks one of the two actions. They also use different dialog containers: `.clock-in-dialog` vs `.clock-out-dialog`.
4. **Reload the page after OTP, before clocking.** Stale ASP.NET session tokens after the OTP step can make the clock AJAX silently no-op even though the client-side success dialog appears. A `page.reload({waitUntil:"networkidle"})` after login refreshes them.
5. **The already-clocked guard fails SAFE.** If it cannot positively confirm that today has NO matching IN/OUT row (selector throws, card missing, page in an odd state), it returns `true` (= already clocked = skip). Better to miss one auto-clock than to double-clock.
6. **Screenshot at every meaningful step.** They are the only post-mortem signal. Per-user/per-run path.

> **About the `.catch(() => false)` / `.catch(() => {})` you'll see below — reproduce it verbatim, do NOT imitate it elsewhere.** In this file `.catch()` is a *deliberate, contained idiom*: Playwright probes (`await locator.isVisible().catch(() => false)`) where a throw legitimately means "element not present", and fire-and-forget cleanup (`.catch(() => {})`) that must never crash the run. It is **not** the project's async style. Everywhere else — services, routes, DB calls — sequential logic is `async`/`await` + `try/catch` (see §03 "Async & modern idioms"). Copy these blocks exactly; never write your own `.then().catch()` business logic.

---

## `src/automation/browser.ts` (copy verbatim)

```ts
import { chromium, type Browser, type BrowserContext } from "playwright";
import {
  ensureDir,
  fileExists,
  storageStatePath,
  userSessionDir,
} from "../lib/paths";

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });
}

export async function createUserContext(
  browser: Browser,
  userId: string,
): Promise<{ context: BrowserContext; usedStorage: boolean }> {
  const path = storageStatePath(userId);
  const usedStorage = await fileExists(path);
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    ...(usedStorage ? { storageState: path } : {}),
  });
  return { context, usedStorage };
}

export async function saveUserStorageState(
  context: BrowserContext,
  userId: string,
): Promise<void> {
  await ensureDir(userSessionDir(userId));
  await context.storageState({ path: storageStatePath(userId) });
}
```

## `src/lib/paths.ts` (copy verbatim — used by browser & screenshot)

```ts
import path from "node:path";
import fs from "node:fs/promises";
import { config } from "../config";

export function storageStatePath(userId: string): string {
  return path.join(config.DATA_DIR, "sessions", userId, "storage-state.json");
}

export function userSessionDir(userId: string): string {
  return path.join(config.DATA_DIR, "sessions", userId);
}

export function screenshotDir(userId: string, runId: string): string {
  return path.join(config.DATA_DIR, "screenshots", userId, runId);
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
```

## `src/automation/screenshot.ts` (copy verbatim)

```ts
import path from "node:path";
import type { Page } from "playwright";
import { ensureDir, screenshotDir } from "../lib/paths";

export async function screenshot(
  page: Page,
  userId: string,
  runId: string,
  name: string,
): Promise<string> {
  const dir = screenshotDir(userId, runId);
  await ensureDir(dir);
  const file = path.join(dir, `${name}-${Date.now()}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}
```

## `src/automation/portal.ts` (copy verbatim)

Navigation with server-error retry, plus the two page-state probes.

```ts
import type { Page } from "playwright";
import { config } from "../config";
import { screenshot } from "./screenshot";

const MAX_NAV_RETRIES = 3;
const NAV_RETRY_DELAY_MS = 30000;

export async function navigateToPortal(
  page: Page,
  userId: string,
  runId: string,
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_NAV_RETRIES; attempt++) {
    await page.goto(config.SPROUT_URL, {
      waitUntil: "networkidle",
      timeout: 60000,
    });
    if (!(await isServerError(page))) return;
    await screenshot(page, userId, runId, `server-error-attempt-${attempt}`);
    if (attempt < MAX_NAV_RETRIES) {
      await page.waitForTimeout(NAV_RETRY_DELAY_MS);
    }
  }
  throw new Error(
    "Portal is returning server errors after all retries. The site may be down.",
  );
}

async function isServerError(page: Page): Promise<boolean> {
  try {
    const body = await page.locator("body").innerText({ timeout: 3000 });
    const lower = body.toLowerCase();
    return (
      lower.includes("server error") ||
      lower.includes("runtime error") ||
      lower.includes("request has been terminated") ||
      lower.includes("503 service") ||
      lower.includes("502 bad gateway")
    );
  } catch {
    return false;
  }
}

export async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    const candidates = ["Attendance", "Clock In/Out", "Sidekick"];
    const visible = await Promise.any(
      candidates.map((label) =>
        page.getByText(label).waitFor({ timeout: 5000 }).then(() => label),
      ),
    ).catch(() => null);
    return visible != null;
  } catch {
    return false;
  }
}

export async function isOnOtpPage(page: Page): Promise<boolean> {
  try {
    const otpField = page
      .locator(
        'input[placeholder*="OTP" i], input[placeholder*="code" i], input[name="otp"], input[name="code"]',
      )
      .first();
    if (await otpField.isVisible().catch(() => false)) return true;

    const bodyText = await page.locator("body").innerText();
    const keywords = [
      "enter otp",
      "otp code",
      "verify your identity",
      "one-time password",
      "we sent",
    ];
    return keywords.some((kw) => bodyText.toLowerCase().includes(kw));
  } catch {
    return false;
  }
}
```

> Note: `isLoggedIn` uses `getByText` deliberately — that's fine for *detecting* the logged-in dashboard (those texts are visible there). The text-selector prohibition is specifically about the **clock action buttons**, which is where invisible-but-present text bites.

## `src/automation/login.ts` (copy verbatim)

Resilient field selectors (HRHub's login markup varies) + OTP detection/fill. `waitForOtpCode` is injected by the caller (it's the IMAP-vs-manual race).

```ts
import type { Page } from "playwright";
import { screenshot } from "./screenshot";

export type SproutCreds = {
  username: string;
  password: string;
};

export async function performLogin(
  page: Page,
  creds: SproutCreds,
  userId: string,
  runId: string,
  log?: (message: string) => void,
): Promise<void> {
  const usernameField = page
    .locator(
      'input[name="username"], input[name="email"], input[name="login"], input[type="email"], input[placeholder*="mail" i], input[placeholder*="user" i]',
    )
    .first();
  const passwordField = page
    .locator('input[name="password"], input[type="password"]')
    .first();

  await usernameField.waitFor({ timeout: 15000 });
  log?.("Entering Sprout username and password...");
  await usernameField.fill(creds.username);
  await passwordField.fill(creds.password);
  await screenshot(page, userId, runId, "before-login-submit");

  log?.("Submitting login form...");
  const submit = page
    .locator('button[type="submit"], input[type="submit"], button.login-btn')
    .first();
  if (await submit.isVisible().catch(() => false)) {
    await submit.click();
  } else {
    await passwordField.press("Enter");
  }

  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await screenshot(page, userId, runId, "after-login-submit");
}

export async function handleOtp(
  page: Page,
  waitForOtpCode: () => Promise<string>,
  userId: string,
  runId: string,
  log?: (message: string) => void,
): Promise<boolean> {
  await page.waitForTimeout(2000);

  const otpField = page
    .locator(
      'input[name="otp"], input[name="code"], input[name="verification_code"], input[placeholder*="OTP" i], input[placeholder*="code" i], input[placeholder*="verification" i], input[maxlength="6"], input[maxlength="4"], input[maxlength="5"]',
    )
    .first();

  const bodyText = await page.locator("body").innerText();
  const keywords = [
    "otp",
    "verification code",
    "one-time",
    "one time",
    "enter code",
    "enter the code",
    "we sent",
  ];
  const hasOtpText = keywords.some((kw) => bodyText.toLowerCase().includes(kw));
  const otpFieldVisible = await otpField.isVisible().catch(() => false);

  if (!otpFieldVisible && !hasOtpText) {
    log?.("OTP prompt not detected. Continuing login...");
    return false;
  }

  log?.("OTP prompt detected. OTP is required to continue.");
  await screenshot(page, userId, runId, "otp-required");

  let targetField = otpFieldVisible ? otpField : null;
  if (!targetField) {
    await page.waitForTimeout(2000);
    const textInputs = page.locator(
      'input[type="text"], input[type="number"], input[type="tel"]',
    );
    if ((await textInputs.count()) > 0) {
      targetField = textInputs.first();
    }
  }
  if (!targetField) {
    throw new Error("OTP is required but could not find OTP input field");
  }

  log?.("Waiting for OTP verification code...");
  const code = await waitForOtpCode();
  log?.("OTP code acquired. Submitting code...");
  await targetField.fill(code);

  const submit = page
    .locator('button[type="submit"], input[type="submit"]')
    .first();
  if (await submit.isVisible().catch(() => false)) {
    await submit.click();
  } else {
    const verifyBtn = page.getByRole("button", {
      name: /verify|submit|confirm/i,
    });
    if (await verifyBtn.isVisible().catch(() => false)) {
      await verifyBtn.click();
    } else {
      await targetField.press("Enter");
    }
  }

  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await screenshot(page, userId, runId, "after-otp-submit");
  log?.("OTP submitted. Resuming verification...");
  return true;
}
```

## `src/automation/clock.ts` (copy verbatim) — THE most fragile file

```ts
// Reads the Attendance card on the dashboard and checks whether today already
// has an IN or OUT entry, then performs the 4-step clock action against the
// bootbox dialogs.

import type { Page } from "playwright";
import { manilaDateString } from "../lib/ph-holidays";
import { screenshot } from "./screenshot";

export type ClockAction = "in" | "out";

export type ClockActionResult = {
  success: boolean;
  message?: string;
  error?: string;
};

/**
 * Returns true when today already has a row for the action we're about to
 * perform (skip). Fail-safe: any unexpected condition returns TRUE — better to
 * miss one auto-clock than to accidentally double-clock.
 */
export async function isAlreadyClockedForToday(
  page: Page,
  action: ClockAction,
  userId: string,
  runId: string,
  log?: (message: string) => void,
): Promise<boolean> {
  const label = action === "in" ? "IN" : "OUT";
  const actionRegex = new RegExp(`\\b${label}\\b`);

  const iso = manilaDateString(new Date()); // e.g. "2026-05-28"
  const parts = iso.split("-");
  const yyyy = parts[0]!;
  const mm = parts[1]!;
  const dd = parts[2]!;
  const yy = yyyy.slice(-2);

  const todayCandidates = [
    `${mm}/${dd}/${yy}`, // 05/28/26
    `${Number(mm)}/${Number(dd)}/${yy}`, // 5/28/26
    `${yyyy}-${mm}-${dd}`, // 2026-05-28 ISO
  ];

  try {
    const attendanceSection = page
      .locator("text=Attendance")
      .locator(
        "xpath=ancestor::*[contains(@class,'card') or contains(@class,'Card') or contains(@class,'panel') or contains(@class,'widget') or contains(@class,'section')]",
      )
      .first();

    let containerText: string;
    if (await attendanceSection.isVisible().catch(() => false)) {
      containerText = await attendanceSection.innerText();
    } else {
      log?.(
        `Could not locate Attendance card. Skipping ${label} as a safety measure.`,
      );
      await screenshot(page, userId, runId, "already-clocked-check-no-card");
      return true;
    }

    const lines = containerText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const matchedLine = lines.find(
      (line) =>
        todayCandidates.some((d) => line.includes(d)) && actionRegex.test(line),
    );

    await screenshot(page, userId, runId, "already-clocked-check");

    if (matchedLine) {
      log?.(
        `Already clocked ${label} today (matched row "${matchedLine}") — skipping.`,
      );
      return true;
    }

    log?.(
      `No ${label} row found for ${todayCandidates[0]} — proceeding with clock action.`,
    );
    return false;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.(
      `Could not verify clock state (${msg}). Skipping ${label} as a safety measure.`,
    );
    await screenshot(page, userId, runId, "already-clocked-check-error").catch(
      () => {},
    );
    return true;
  }
}

export async function performClockAction(
  page: Page,
  action: ClockAction,
  userId: string,
  runId: string,
  log?: (message: string) => void,
): Promise<ClockActionResult> {
  const actionLabel = action === "in" ? "Clock In" : "Clock Out";

  // Step 1: open dropdown — desktop button preferred, mobile fallback
  log?.("Opening clock action dropdown...");
  const dskBtn = page.locator(".clock-in-out-dropdown .dsk-btn").first();
  const mblBtn = page.locator(".clock-in-out-dropdown .mbl-btn").first();
  if (await dskBtn.isVisible().catch(() => false)) {
    await dskBtn.click();
  } else if (await mblBtn.isVisible().catch(() => false)) {
    await mblBtn.click();
  } else {
    throw new Error(
      "Neither .dsk-btn nor .mbl-btn found in .clock-in-out-dropdown",
    );
  }
  await page.waitForTimeout(500);
  await screenshot(page, userId, runId, `${action}-dropdown-opened`);

  // Step 2: click the action <a> inside the dropdown menu
  log?.(`Selecting dropdown menu option: ${actionLabel}...`);
  const menuLink = page
    .locator(".clock-in-out-dropdown .dropdown-menu a")
    .filter({ hasText: actionLabel });
  await menuLink.waitFor({ state: "visible", timeout: 5000 });
  await menuLink.click();

  // Step 3: bootbox confirmation — "Yes" button
  log?.("Waiting for Sprout confirmation dialog...");
  const dialogClass =
    action === "in" ? ".clock-in-dialog" : ".clock-out-dialog";
  const yesBtn = page.locator(`${dialogClass} .our-button`);
  await yesBtn.waitFor({ state: "visible", timeout: 15000 });
  await screenshot(page, userId, runId, `${action}-confirmation-modal`);
  log?.("Clicking confirmation button...");
  await yesBtn.click();

  // Step 4: success bootbox alert (different titles for in vs out)
  log?.("Waiting for portal success response...");
  const successTitle =
    action === "in" ? "Time Entry Confirmation" : "Clocking Status Update";
  const successDialog = page
    .locator(`${dialogClass} .modal-title`)
    .filter({ hasText: successTitle });

  const successAppeared = await successDialog
    .waitFor({ state: "visible", timeout: 30000 })
    .then(() => true)
    .catch(() => false);

  if (successAppeared) {
    const bodyText = await page
      .locator(`${dialogClass} .bootbox-body`)
      .innerText()
      .catch(() => "");
    await screenshot(page, userId, runId, `${action}-success`);
    const okBtn = page.locator(`${dialogClass} .btn-primary`);
    if (await okBtn.isVisible().catch(() => false)) {
      await okBtn.click();
    }
    return { success: true, message: bodyText.trim() };
  }

  // Error dialog path
  const errorBody = await page
    .locator(`${dialogClass} .bootbox-body`)
    .innerText()
    .catch(() => "");
  if (errorBody) {
    await screenshot(page, userId, runId, `${action}-error-dialog`);
    const okBtn = page.locator(`${dialogClass} .btn-primary`);
    if (await okBtn.isVisible().catch(() => false)) {
      await okBtn.click();
    }
    return { success: false, error: errorBody.trim() };
  }

  await screenshot(page, userId, runId, `${action}-no-success-modal`);
  return {
    success: false,
    error: "Clock action completed but no confirmation dialog appeared",
  };
}
```

## `src/automation/runAutomation.ts` (copy verbatim) — orchestration

```ts
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
    if (await isAlreadyClockedForToday(page, action, userId, runId, log)) {
      return { success: true, skipped: true, loginMethod };
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
```

---

## Login-method semantics (for the `runs.login_method` column)

- `saved_session` — the stored storage-state was still valid; no login form, no OTP.
- `fresh_login` — filled credentials, no OTP challenge appeared.
- `fresh_login_with_otp` — filled credentials and completed an OTP challenge.
- `session_otp` — landed directly on an OTP page (session half-alive), completed OTP.

## When HRHub changes its markup (future you)

If a run starts failing at the clock step, the selectors are the first suspect. Re-capture the DOM at 1920×1080, compare against the classes above, and update `clock.ts`. Keep the screenshot-at-every-step discipline — that's how you'll know which step broke.
