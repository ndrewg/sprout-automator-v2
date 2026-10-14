import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { screenshot } from "../../src/automation/screenshot";
import { screenshotDir } from "../../src/lib/paths";

// Phase 17 § 17A: "a screenshot failure (I/O error) must never fail a run".
// The old helper let the error propagate, so a full disk could turn a successful
// clock into a failed one — the screenshot is a diagnostic, not the work.

const created: string[] = [];

function fakePage(impl: (options: { path: string }) => Promise<void>): Page {
  // Only `page.screenshot` is used by the helper; the rest of Page is irrelevant.
  return { screenshot: impl } as unknown as Page;
}

afterEach(async () => {
  await Promise.all(
    created.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("screenshot", () => {
  it("captures into the per-user/per-run directory and returns the path", async () => {
    const userId = randomUUID();
    const runId = randomUUID();
    created.push(screenshotDir(userId, runId));
    const written: string[] = [];
    const page = fakePage(async ({ path }) => {
      written.push(path);
    });

    const file = await screenshot(page, userId, runId, "clock-in-done");

    expect(written).toEqual([file]);
    expect(file.startsWith(screenshotDir(userId, runId))).toBe(true);
    expect(file).toContain("clock-in-done");
  });

  it("resolves (and stays silent apart from a log line) when the capture throws", async () => {
    const userId = randomUUID();
    const runId = randomUUID();
    created.push(screenshotDir(userId, runId));
    const page = fakePage(async () => {
      throw new Error("ENOSPC: no space left on device, write");
    });

    await expect(
      screenshot(page, userId, runId, "clock-in-done"),
    ).resolves.toContain("clock-in-done");
  });
});
