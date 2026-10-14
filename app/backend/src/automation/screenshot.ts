import path from "node:path";
import type { Page } from "playwright";
import { ensureDir, screenshotDir } from "../lib/paths";
import { logger } from "../lib/logger";

/**
 * A per-user/per-run screenshot. The path is returned either way.
 *
 * IT NEVER THROWS (phase 17 § 17A). Screenshots are the only post-mortem signal
 * for HRHub markup drift, but they are diagnostics: a full disk, a permissions
 * problem or a page that closed mid-capture must not take the clock attempt
 * down with it — the old version let the I/O error propagate out of the run.
 */
export async function screenshot(
  page: Page,
  userId: string,
  runId: string,
  name: string,
): Promise<string> {
  const dir = screenshotDir(userId, runId);
  const file = path.join(dir, `${name}-${Date.now()}.png`);
  try {
    await ensureDir(dir);
    await page.screenshot({ path: file, fullPage: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { userId, runId, name, error: message },
      "screenshot failed — continuing",
    );
  }
  return file;
}
