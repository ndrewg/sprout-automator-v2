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
