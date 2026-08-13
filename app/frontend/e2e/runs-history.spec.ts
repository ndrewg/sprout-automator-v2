import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Phase 9B: with more runs than the 10-row default, "Show more" appends rows
// and the button disappears once everything is loaded. Runs are seeded directly
// into sprout_test via the backend helper (test/e2e-seed-runs.ts) — they never
// execute, so this is fast and deterministic and no Chromium is launched.
//
// This file runs on BOTH the desktop and the 375px mobile project; each worker
// signs up its own fresh email so the two never collide.

const BACKEND_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "backend",
);

// 40 > default 10, and > 30 (10 + one "Show more" step of 20), so a SECOND
// click is exercised and the button only disappears after the last row.
const SEED_COUNT = 40;

function seedRuns(userId: string, count: number): void {
  const result = spawnSync(
    "pnpm",
    ["exec", "tsx", "test/e2e-seed-runs.ts", userId, String(count)],
    {
      cwd: BACKEND_DIR,
      env: {
        ...process.env,
        NODE_ENV: "test",
        DATABASE_URL:
          "postgres://sprout:sprout_dev_pw@localhost:5432/sprout_test",
        APP_ENCRYPTION_KEY: "0".repeat(64),
        SESSION_SECRET: "e2e-session-secret-not-for-production-123456789",
      },
      shell: true,
      stdio: "pipe",
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `seedRuns failed (exit ${result.status}): ${
        result.stderr?.toString() || result.stdout?.toString()
      }`,
    );
  }
}

test("run history: Show more appends rows, the count stays honest, the button disappears", async ({
  page,
}) => {
  const email = `e2e-runs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const password = "e2e-runs-password-123";

  await page.goto("/");
  await page.getByRole("button", { name: "Need an account? Sign up" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();

  // The fresh session cookie lets us read the authed user's id in-page.
  const me = await page.evaluate<{ user: { id: string } }>(() =>
    fetch("/auth/me").then((r) => r.json()),
  );
  seedRuns(me.user.id, SEED_COUNT);
  await page.reload();

  // Default view: 10 rows, an honest count, and Show more present.
  await expect(page.getByText("Showing 10", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Show more" })).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(10);

  // First click: window grows to 30, still more to show.
  await page.getByRole("button", { name: "Show more" }).click();
  await expect(page.getByText("Showing 30", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Show more" })).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(30);

  // Second click: everything is loaded, the button disappears.
  await page.getByRole("button", { name: "Show more" }).click();
  await expect(page.getByText("Showing 40", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Show more" })).toHaveCount(0);
  await expect(page.locator("tbody tr")).toHaveCount(40);
});
