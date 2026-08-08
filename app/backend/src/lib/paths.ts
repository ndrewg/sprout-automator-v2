import path from "node:path";
import fs from "node:fs/promises";
import { config } from "../config";

export function storageStatePath(userId: string): string {
  return path.join(config.DATA_DIR, "sessions", userId, "storage-state.json");
}

export function userSessionDir(userId: string): string {
  return path.join(config.DATA_DIR, "sessions", userId);
}

export function screenshotDir(userId: string, runId: string): string {
  return path.join(config.DATA_DIR, "screenshots", userId, runId);
}

export function userScreenshotRoot(userId: string): string {
  return path.join(config.DATA_DIR, "screenshots", userId);
}

/**
 * Removes everything the automation wrote for one user: the Playwright
 * storage-state dir (data/sessions/<userId>) and the screenshots dir
 * (data/screenshots/<userId>). Called by account deletion. Best-effort — the
 * dirs may not exist, and the caller decides whether a failure matters.
 */
export async function removeUserData(userId: string): Promise<void> {
  await Promise.all([
    fs.rm(userSessionDir(userId), { recursive: true, force: true }),
    fs.rm(userScreenshotRoot(userId), { recursive: true, force: true }),
  ]);
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
