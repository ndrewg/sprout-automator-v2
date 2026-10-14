import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Phase 16C — the day calendar in the Schedule panel. Runs against the built
// SPA + real backend (sprout_test). EXTRA_HOLIDAYS on the e2e server pins an
// operator holiday on TOMORROW (Manila) — see e2e-server.mjs — so the "mark a
// holiday as a workday" flow is deterministic whatever real PH holidays fall in
// the current month.
//
// Each worker signs up a fresh email, so the desktop and 375px mobile project
// never collide.

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

function monthIndex(iso: string): number {
  const [y, m] = iso.split("-").map(Number);
  return y! * 12 + (m! - 1);
}

async function signUp(page: Page, tag: string): Promise<void> {
  const email = `e2e-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await page.goto("/");
  await page.getByRole("button", { name: "Need an account? Sign up" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("e2e-calendar-password-123");
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
}

/** Today, in MANILA, from the server — never the browser's own date. */
async function manilaToday(page: Page): Promise<string> {
  return page.evaluate(() =>
    fetch("/schedule")
      .then((r) => r.json())
      .then((b: { schedule: { today: { date: string } } }) => b.schedule.today.date),
  );
}

/** The calendar opens on today's month; click forward to reach `target`. */
async function goToMonth(
  page: Page,
  targetIso: string,
  todayIso: string,
): Promise<void> {
  const diff = monthIndex(targetIso) - monthIndex(todayIso);
  for (let i = 0; i < diff; i += 1) {
    await page.getByRole("button", { name: "Next month" }).click();
  }
}

async function openDay(page: Page, iso: string): Promise<void> {
  await page.locator(`[data-day-iso="${iso}"]`).click();
  await expect(page.getByRole("dialog", { name: "Day details" })).toBeVisible();
}

test("calendar: mark a holiday as a workday, and it survives a reload", async ({
  page,
}) => {
  await signUp(page, "cal-holiday");
  const today = await manilaToday(page);
  const tomorrow = addDays(today, 1);

  await goToMonth(page, tomorrow, today);
  await openDay(page, tomorrow);

  // Tomorrow is the pinned operator holiday.
  await expect(page.getByText("Holiday: E2E Test Holiday")).toBeVisible();

  await page.getByRole("button", { name: "Work this day" }).click();
  await expect(page.getByText("Marked as a workday.")).toBeVisible();
  await expect(page.getByText("Work override")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();

  // The override is durable: it is in the database, not component state.
  await page.reload();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  await goToMonth(page, tomorrow, today);
  await openDay(page, tomorrow);
  const dialog = page.getByRole("dialog", { name: "Day details" });
  await expect(dialog.getByText("Work override")).toBeVisible();
  await expect(dialog.getByText("You work this day")).toBeVisible();

  // Clean up.
  await page.getByRole("button", { name: "Clear override" }).click();
  await expect(page.getByText("Override cleared.")).toBeVisible();
});

test("calendar: mark a workday as a skip, then clear it", async ({ page }) => {
  await signUp(page, "cal-skip");
  const today = await manilaToday(page);
  const from = addDays(today, 1);
  const to = addDays(today, 21);

  // Ask the API for the first future work day — never guess a date.
  const target = await page.evaluate(
    async ([f, t]) => {
      const res = await fetch(`/schedule/days?from=${f}&to=${t}`);
      const body = (await res.json()) as {
        days: { date: string; work: boolean }[];
      };
      return body.days.find((d) => d.work)?.date ?? null;
    },
    [from, to] as const,
  );
  expect(target).not.toBeNull();

  await goToMonth(page, target!, today);
  await openDay(page, target!);
  await expect(page.getByText("Work day — clocking in and out")).toBeVisible();

  await page.getByRole("button", { name: "Skip this day" }).click();
  await expect(page.getByText("Marked as a skip day.")).toBeVisible();
  await expect(page.getByText("Skip override")).toBeVisible();

  // Keyboard: Escape closes the day popover and focus returns to the day.
  await page.keyboard.press("Escape");
  await expect(page.locator(`[data-day-iso="${target}"]`)).toBeFocused();

  // Reopen and clear.
  await openDay(page, target!);
  await page.getByRole("button", { name: "Clear override" }).click();
  await expect(page.getByText("Override cleared.")).toBeVisible();
  await expect(page.getByText("Work day — clocking in and out")).toBeVisible();
});

test("calendar panel passes an accessibility check", async ({ page }) => {
  await signUp(page, "cal-a11y");
  // Render a day's popover too, so the check covers the actions, not just the
  // grid.
  const today = await manilaToday(page);
  await openDay(page, today);

  const results = await new AxeBuilder({ page })
    .include('[data-testid="schedule-panel"]')
    // The day popover is portaled to <body>, so it is outside the panel.
    .include('[data-slot="popover-content"]')
    .analyze();
  expect(results.violations).toEqual([]);
});
