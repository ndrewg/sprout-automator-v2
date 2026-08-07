import { expect, test } from "@playwright/test";

// 4B password reset UI, against the built SPA + real backend. In dev/test the
// reset email is only logged (no provider), so the raw token is unreachable
// from the browser. What this proves is the wiring: the forgot form is
// reachable and always answers with the generic confirmation, and /reset?token=
// serves the reset form which surfaces the backend's generic error for an
// unknown token.

test("forgot password: shows the generic confirmation for any address", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Forgot password?" }).click();
  await page.getByLabel("Email").fill("nobody@example.com");
  await page.getByRole("button", { name: "Send reset link" }).click();
  // Generic — the server answers 200 whether or not the account exists.
  await expect(page.getByText("Check your email")).toBeVisible();
  await expect(page.getByText(/password reset link is on its way/)).toBeVisible();
});

test("reset: a token in the URL serves the reset form and an unknown token errors", async ({ page }) => {
  await page.goto("/reset?token=not-a-real-token");
  await expect(page.getByLabel("New password")).toBeVisible();
  await page.getByLabel("New password").fill("brand-new-password-456");
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.getByText("Reset failed")).toBeVisible();
  await expect(page.getByText("Invalid or expired token")).toBeVisible();
});

test("reset while authenticated: the reset screen renders instead of the dashboard", async ({ page }) => {
  // Sign up → a live session exists (this is the case A3 broke: the dashboard
  // swallowed the link because AuthGate never consulted location.search).
  const email = `e2e-auth-reset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await page.goto("/");
  await page.getByRole("button", { name: "Need an account? Sign up" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("e2e-reset-password-123");
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();

  // Opening a reset link must show the reset screen, NOT the dashboard.
  await page.goto("/reset?token=not-a-real-token");
  await expect(page.getByLabel("New password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Log out" })).toHaveCount(0);

  // And the form is the real one — it surfaces the backend's generic error.
  await page.getByLabel("New password").fill("brand-new-password-456");
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.getByText("Invalid or expired token")).toBeVisible();
});
