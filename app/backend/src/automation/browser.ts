import { chromium, type Browser, type BrowserContext } from "playwright";
import {
  ensureDir,
  fileExists,
  storageStatePath,
  userSessionDir,
} from "../lib/paths";

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });
}

export async function createUserContext(
  browser: Browser,
  userId: string,
): Promise<{ context: BrowserContext; usedStorage: boolean }> {
  const path = storageStatePath(userId);
  const usedStorage = await fileExists(path);
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    ...(usedStorage ? { storageState: path } : {}),
  });
  return { context, usedStorage };
}

export async function saveUserStorageState(
  context: BrowserContext,
  userId: string,
): Promise<void> {
  await ensureDir(userSessionDir(userId));
  await context.storageState({ path: storageStatePath(userId) });
}
