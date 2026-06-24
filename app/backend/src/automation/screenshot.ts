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
