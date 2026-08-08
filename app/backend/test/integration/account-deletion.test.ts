import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client";
import {
  auditLog,
  credentials,
  missedRunNotices,
  notificationSettings,
  resetTokens,
  runs,
  schedules,
  sessions,
  users,
} from "../../src/db/schema";
import { hashToken } from "../../src/lib/reset-tokens";
import { userSessionDir, screenshotDir } from "../../src/lib/paths";
import {
  closeTestServer,
  createUser,
  request,
  resetDatabase,
  setupDatabase,
  startTestServer,
  type TestServer,
} from "./harness";

// 4B.5 account deletion. DELETE /auth/account re-confirms the password, refuses
// while a run is active, stops the cron schedule, writes a surviving
// account_deleted audit row (user_id null via the SET NULL FK, emailHash only),
// cascades every owned row, removes the user's data directories, and clears the
// session cookie.

// Fixture only — must be >=12 chars to clear the signup schema. Not a secret.
const password = "delete-confirm-password-123"; // gitleaks:allow

function emailHash(email: string): string {
  // Mirrors the route's non-reversible helper.
  return createHash("sha256").update(email).digest("hex").slice(0, 16);
}

async function deleteAccount(cookie: string, pw: string) {
  return request("/auth/account", {
    cookie,
    method: "DELETE",
    body: { password: pw },
  });
}

describe("account deletion (§4B.5)", () => {
  beforeAll(async () => {
    await setupDatabase();
    const srv: TestServer = await startTestServer();
  });
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await closeTestServer();
  });

  it("refuses without a session", async () => {
    const res = await request("/auth/account", {
      method: "DELETE",
      body: { password },
    });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Not authenticated" });
  });

  it("refuses a wrong password with 401 and leaves the account intact", async () => {
    const { cookie } = await createUser();
    const res = await deleteAccount(cookie, "definitely-not-the-password");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Incorrect password" });

    // The session still works and the user still exists.
    expect((await request("/auth/me", { cookie })).status).toBe(200);
    const usersLeft = await db.select().from(users);
    expect(usersLeft).toHaveLength(1);
  });

  it("refuses while a run is pending, and allows it once the run is terminal", async () => {
    const { user, cookie } = await createUser({ password });
    await db
      .insert(runs)
      .values({ userId: user.id, action: "in", status: "pending" });

    const refused = await deleteAccount(cookie, password);
    expect(refused.status).toBe(409);
    expect((refused.body as { error: string }).error).toMatch(/run/i);

    // Nothing was deleted.
    expect((await db.select().from(users))).toHaveLength(1);
    const runRows = await db.select().from(runs).where(eq(runs.userId, user.id));
    expect(runRows).toHaveLength(1);

    // Once the run is terminal the deletion goes through.
    await db
      .update(runs)
      .set({ status: "success", finishedAt: new Date() })
      .where(eq(runs.userId, user.id));
    const ok = await deleteAccount(cookie, password);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });
  });

  it("refuses while a run is running", async () => {
    const { user, cookie } = await createUser({ password });
    await db
      .insert(runs)
      .values({ userId: user.id, action: "out", status: "running" });

    const refused = await deleteAccount(cookie, password);
    expect(refused.status).toBe(409);

    // Still alive.
    expect((await db.select().from(users))).toHaveLength(1);
  });

  it("cascades credentials, schedule, runs, sessions, notification settings, reset tokens and missed notices", async () => {
    const { user, cookie } = await createUser({ password });
    const userId = user.id;

    await request("/credentials", {
      cookie,
      method: "PUT",
      body: {
        sproutUsername: "delete-me-user",
        sproutPassword: "sprout-pass-1234",
        gmailEmail: "delete-me@gmail.com",
        gmailAppPassword: "app-pass-1234",
      },
    });
    await request("/schedule", {
      cookie,
      method: "PUT",
      body: { clockInTime: "06:00", clockOutTime: "17:00", enabled: true },
    });
    await request("/notifications", {
      cookie,
      method: "PUT",
      body: {
        telegramBotToken: "223456789:BCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi", // gitleaks:allow
        telegramChatId: "999999999",
        enabled: true,
      },
    });
    await db
      .insert(runs)
      .values({ userId, action: "in", status: "success", finishedAt: new Date() });
    await db
      .insert(missedRunNotices)
      .values({ userId, manilaDate: "2026-08-07", action: "in" });
    await db.insert(resetTokens).values({
      userId,
      tokenHash: hashToken("raw-reset-token"),
      purpose: "reset",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    // A second session for the same user — the cascade must kill it too.
    const login = await request("/auth/login", {
      method: "POST",
      body: { email: user.email, password },
    });
    expect(login.status).toBe(200);

    const res = await deleteAccount(cookie, password);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // Every owned table is empty; the user row is gone.
    const owned = [
      credentials,
      schedules,
      runs,
      sessions,
      notificationSettings,
      missedRunNotices,
      resetTokens,
    ];
    for (const table of owned) {
      const rows = await db.select().from(table);
      expect(rows).toHaveLength(0);
    }
    expect((await db.select().from(users))).toHaveLength(0);
  });

  it("the account_deleted audit row survives with user_id null and a usable emailHash", async () => {
    const { user, cookie } = await createUser({ password });

    const res = await deleteAccount(cookie, password);
    expect(res.status).toBe(200);

    const deleted = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "account_deleted"));
    expect(deleted).toHaveLength(1);
    const row = deleted[0]!;
    expect(row.userId).toBeNull();
    const meta = row.metadata as { emailHash?: string };
    expect(meta.emailHash).toBe(emailHash(user.email));
    // The address itself never appears in the trail.
    expect(JSON.stringify(row.metadata)).not.toContain(user.email);

    // The earlier audit rows (e.g. signup) also survived with null user_id.
    const signups = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "signup"));
    expect(signups).toHaveLength(1);
    expect(signups[0]!.userId).toBeNull();
  });

  it("removes the user's session and screenshot directories", async () => {
    const { user, cookie } = await createUser({ password });
    const sessionDir = userSessionDir(user.id);
    const shotDir = screenshotDir(user.id, "some-run-id");
    await fs.mkdir(path.join(sessionDir, "nested"), { recursive: true });
    await fs.writeFile(path.join(sessionDir, "storage-state.json"), "{}");
    await fs.mkdir(shotDir, { recursive: true });

    try {
      const res = await deleteAccount(cookie, password);
      expect(res.status).toBe(200);

      await expect(fs.access(sessionDir)).rejects.toThrow();
      await expect(fs.access(shotDir)).rejects.toThrow();
    } finally {
      // A failed run must not leave test debris in the shared DATA_DIR.
      await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
      await fs.rm(shotDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("clears the session cookie so the browser cannot hold a dead sid", async () => {
    const { cookie } = await createUser({ password });
    const res = await deleteAccount(cookie, password);
    expect(res.status).toBe(200);

    const setCookie = res.headers.get("set-cookie") ?? "";
    // The response clears the sid cookie (expiry in the past)…
    expect(setCookie).toContain("sid=");
    expect(setCookie).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);

    // The old cookie no longer authenticates.
    expect((await request("/auth/me", { cookie })).status).toBe(401);
  });
});
