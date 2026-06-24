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
