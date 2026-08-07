import { expect, test } from "@playwright/test";

// One smoke flow for the whole SPA: the full happy path a user actually
// performs. Depth belongs in the integration suite; this proves the built app
// wires together — auth, the signed session cookie across a full reload, the
// persistence of encrypted credentials and the schedule, and the responsive
// layout at both viewports. Runs against the built SPA + real backend.
//
// No test contains a real credential: everything below is throwaway.
// Each run signs up a fresh email so reruns never collide.

// Two projects (desktop + mobile) run this file in parallel, and each worker
// evaluates `email` at module load. Date.now() alone is not enough: two
// workers spawning in the same millisecond collide on the same email and the
// second signup 409s. The random suffix keeps the fresh-email guarantee per
// worker while still ending in @example.com (admitted by the test allowlist).
const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
const password = "e2e-signup-password-123";
const sproutUsername = "e2e-sprout-user";
const sproutPassword = "e2e-sprout-password-123";

// Phase 7 pause dates. Tomorrow must be the MANILA calendar day (the server's
// wall clock) — the browser may be in any timezone, and the UI computes from
// schedule.today.date, so the test mirrors that with the same Intl formatting.
function manilaDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

// shadcn CardTitle is a div, not a heading — anchor on the dashboard's Log out
// button instead. The Credentials card labels carry dynamic badges, so target
// the credential inputs by id.
test("signup → credentials → schedule → reload → logout → login", async ({ page }) => {
  // --- Sign up (auto-login) ---
  await page.goto("/");
  await page.getByRole("button", { name: "Need an account? Sign up" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign up" }).click();

  // Dashboard renders (Log out only exists there).
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();

  // --- Save Sprout credentials ---
  await page.getByLabel("Username").fill(sproutUsername);
  await page.locator("#sproutPassword").fill(sproutPassword);
  await page.getByRole("button", { name: "Save Sprout credentials" }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();

  // --- Save a schedule with "run automatically" enabled ---
  await page.getByLabel("Clock in").fill("05:30");
  await page.getByLabel("Clock out").fill("18:05");
  await page.getByLabel("Run automatically Mon–Fri").check();
  await page.getByRole("button", { name: "Save schedule" }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();

  // --- "Skip tomorrow" sets both pause dates in one click ---
  const today = manilaDate(new Date());
  const tomorrow = addDays(today, 1);
  await page.getByRole("button", { name: "Skip tomorrow" }).click();
  await expect(page.getByLabel("Pause from")).toHaveValue(tomorrow);
  await expect(page.getByLabel("Pause until")).toHaveValue(tomorrow);
  // Tomorrow is not today, so no "paused today" banner yet.
  await expect(page.getByText("Auto-runs are paused until")).toHaveCount(0);

  // --- Reload: both must have persisted (session cookie + encrypted rows) ---
  await page.reload();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  await expect(page.getByLabel("Username")).toHaveValue(sproutUsername);
  await expect(page.getByLabel("Run automatically Mon–Fri")).toBeChecked();
  await expect(page.getByLabel("Clock in")).toHaveValue("05:30");
  await expect(page.getByLabel("Clock out")).toHaveValue("18:05");
  await expect(page.getByLabel("Pause from")).toHaveValue(tomorrow);
  await expect(page.getByLabel("Pause until")).toHaveValue(tomorrow);

  // --- A pause covering today shows the paused banner; clearing removes it ---
  await page.getByLabel("Pause from").fill(today);
  await page.getByLabel("Pause until").fill(today);
  await page.getByRole("button", { name: "Save schedule" }).click();
  await expect(
    page.getByText("Auto-runs are paused until", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("You can still clock in manually."),
  ).toBeVisible();

  await page.getByRole("button", { name: "Clear pause" }).click();
  await expect(page.getByText("Auto-runs are paused until")).toHaveCount(0);
  await expect(page.getByLabel("Pause from")).toHaveValue("");
  await expect(page.getByLabel("Pause until")).toHaveValue("");

  // --- Log out ---
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();

  // --- Log back in: everything still there ---
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  await expect(page.getByLabel("Username")).toHaveValue(sproutUsername);
  await expect(page.getByLabel("Run automatically Mon–Fri")).toBeChecked();
});
