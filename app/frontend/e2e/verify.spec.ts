import { expect, test } from "@playwright/test";

// 4B.2 email verification UI, against the built SPA + real backend. In
// dev/test the verification email is only logged (no provider), so the raw
// token is unreachable from the browser. What this proves is the wiring: a
// fresh signup shows the unverified banner with a working resend action, and
// /verify?token=… serves the verify screen which surfaces the backend's generic
// error for an unknown token.

test("signup shows the unverified banner and resend answers", async ({ page }) => {
  const email = `e2e-verify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await page.goto("/");
  await page.getByRole("button", { name: "Need an account? Sign up" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("e2e-verify-password-123");
  await page.getByRole("button", { name: "Sign up" }).click();

  // The dashboard shows the verification banner for a fresh signup.
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  await expect(page.getByText("Email not verified")).toBeVisible();

  // Resend answers with a confirmation.
  await page.getByRole("button", { name: "Resend verification email" }).click();
  await expect(page.getByText("Verification email sent")).toBeVisible();
});

test("a verify link renders the verify screen and surfaces the generic error", async ({ page }) => {
  await page.goto("/verify?token=not-a-real-token");
  await expect(page.getByRole("button", { name: "Verify email" })).toBeVisible();
  await page.getByRole("button", { name: "Verify email" }).click();
  await expect(page.getByText("Verification failed")).toBeVisible();
  await expect(page.getByText("Invalid or expired link")).toBeVisible();
});

test("verify while authenticated: the verify screen renders instead of the dashboard", async ({ page }) => {
  // Sign up → a live session exists (the same shape as the A3 reset bug: a
  // logged-in user opening the emailed link must reach the verify screen, not
  // the dashboard).
  const email = `e2e-verify-auth-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await page.goto("/");
  await page.getByRole("button", { name: "Need an account? Sign up" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("e2e-verify-password-123");
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();

  // Opening a verify link must show the verify screen, NOT the dashboard.
  await page.goto("/verify?token=not-a-real-token");
  await expect(page.getByRole("button", { name: "Verify email" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Log out" })).toHaveCount(0);

  // And it is the real screen — it surfaces the backend's generic error.
  await page.getByRole("button", { name: "Verify email" }).click();
  await expect(page.getByText("Invalid or expired link")).toBeVisible();
});
