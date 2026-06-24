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
