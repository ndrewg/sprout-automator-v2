import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  clearUserStorageState,
  ensureDir,
  fileExists,
  storageStatePath,
  userSessionDir,
} from "../../src/lib/paths";

// A saved storage state that Sprout half-honours — enough to show an OTP page,
// not enough to finish logging in — is worse than none at all: every later run
// reloads it and fails identically, and a failed run never reaches
// saveUserStorageState to overwrite it. One such file caused five days of
// failures (2026-09-06..11), so clearing it is now part of the failure path.
// Each test uses a throwaway user id and cleans up after itself.

const created: string[] = [];

async function makeStorageState(userId: string): Promise<string> {
  const file = storageStatePath(userId);
  await ensureDir(userSessionDir(userId));
  await fs.writeFile(file, '{"cookies":[]}', "utf8");
  created.push(userSessionDir(userId));
  return file;
}

afterEach(async () => {
  await Promise.all(
    created.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("clearUserStorageState", () => {
  it("deletes the saved storage state", async () => {
    const userId = randomUUID();
    const file = await makeStorageState(userId);
    expect(await fileExists(file)).toBe(true);

    await clearUserStorageState(userId);

    expect(await fileExists(file)).toBe(false);
  });

  it("is a no-op when there is nothing saved — the failure path may clear twice", async () => {
    const userId = randomUUID();
    await expect(clearUserStorageState(userId)).resolves.toBeUndefined();
  });

  it("leaves the rest of the user's session dir alone", async () => {
    const userId = randomUUID();
    await makeStorageState(userId);
    const sibling = path.join(userSessionDir(userId), "keep-me.txt");
    await fs.writeFile(sibling, "keep", "utf8");

    await clearUserStorageState(userId);

    expect(await fileExists(sibling)).toBe(true);
  });
});
