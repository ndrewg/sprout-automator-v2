import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client";
import { auditLog, resetTokens, sessions, users } from "../../src/db/schema";
import { hashPassword } from "../../src/lib/passwords";
import { createResetToken, hashToken } from "../../src/lib/reset-tokens";
import {
  closeTestServer,
  request,
  resetDatabase,
  setupDatabase,
  startTestServer,
  type TestServer,
} from "./harness";

// 4B.3 password reset. The raw token is only ever emailed (or logged, in dev),
// never stored or returned — so the reset endpoint is exercised with tokens
// minted via the lib function, while forgot-password is asserted to create a
// properly-hashed row. Every response is deliberately generic: account
// existence, and invalid-vs-expired-vs-used tokens, are indistinguishable.
//
// Users are created straight in the DB (hashPassword is the real Argon2
// function) instead of through POST /auth/signup: the signup and login routes
// share the in-memory 10/15min authLimiter, and a dozen HTTP auth calls in one
// file would exhaust it. The login POSTs below are the subject under test, so
// those MUST go through the real route; user creation is not.

const password = "original-password-1234";
const newPassword = "brand-new-password-456";

let baseUrl = "";

async function makeUser(email: string): Promise<{ id: string; email: string }> {
  const passwordHash = await hashPassword(password);
  const [u] = await db.insert(users).values({ email, passwordHash }).returning();
  if (!u) throw new Error("makeUser: insert returned no row");
  return { id: u.id, email: u.email };
}

async function forgotPassword(email: string) {
  return request("/auth/forgot-password", {
    method: "POST",
    body: { email },
  });
}

async function resetPassword(token: string, pw: string = newPassword) {
  return request("/auth/reset-password", {
    method: "POST",
    body: { token, newPassword: pw },
  });
}

async function tokenRowsFor(userId: string) {
  return db.select().from(resetTokens).where(eq(resetTokens.userId, userId));
}

// A signed sid cookie via the REAL login route.
async function loginCookie(email: string, pw: string): Promise<string> {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: pw }),
  });
  if (res.status !== 200) throw new Error(`login returned ${res.status}`);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = setCookie.split(",")[0]?.match(/^sid=([^;]+)/);
  if (!match) throw new Error("login did not set a sid cookie");
  return `sid=${match[1]}`;
}

describe("password reset (§4B.3)", () => {
  beforeAll(async () => {
    await setupDatabase();
    const srv: TestServer = await startTestServer();
    baseUrl = srv.baseUrl;
  });
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await closeTestServer();
  });

  it("forgot-password answers 200 and stores only a hashed token for an existing account", async () => {
    const user = await makeUser("reset-existing@example.com");
    const res = await forgotPassword(user.email);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const rows = await tokenRowsFor(user.id);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.purpose).toBe("reset");
    expect(row.usedAt).toBeNull();
    // 64 hex chars = SHA-256, never the base64url raw value.
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
    // ~1 hour expiry, never far beyond.
    expect(row.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
      60 * 60 * 1000 + 5000,
    );

    const audit = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "password_reset_requested"));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.userId).toBe(user.id);
  });

  it("forgot-password for a nonexistent address answers the same 200 and creates no token", async () => {
    const before = await db.select().from(resetTokens);
    const res = await forgotPassword("nobody@example.com");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const after = await db.select().from(resetTokens);
    expect(after).toHaveLength(before.length);
    const audit = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "password_reset_requested"));
    expect(audit).toHaveLength(0);
  });

  it("never reveals whether the address exists — the responses are byte-identical", async () => {
    const user = await makeUser("reset-identical@example.com");
    const existing = await forgotPassword(user.email);
    const missing = await forgotPassword("ghost@example.com");
    expect(existing.status).toBe(200);
    expect(missing.status).toBe(existing.status);
    expect(JSON.stringify(missing.body)).toBe(JSON.stringify(existing.body));
  });

  it("stores only the token hash, never the raw token", async () => {
    const user = await makeUser("reset-hash@example.com");
    const raw = await createResetToken(user.id);
    const rows = await tokenRowsFor(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toBe(raw);
    expect(rows[0]!.tokenHash).toBe(hashToken(raw));
  });

  it("a used token cannot be reused", async () => {
    const user = await makeUser("reset-reuse@example.com");
    const token = await createResetToken(user.id);

    const first = await resetPassword(token);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true });

    const second = await resetPassword(token, "another-password-789");
    expect(second.status).toBe(400);
    expect(second.body).toEqual({ error: "Invalid or expired token" });
  });

  it("an expired token is rejected and left unmarked", async () => {
    const user = await makeUser("reset-expired@example.com");
    const token = await createResetToken(user.id);
    await db
      .update(resetTokens)
      .set({ expiresAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(resetTokens.userId, user.id));

    const res = await resetPassword(token);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid or expired token" });
    // Rejected before the single-use claim: the row must not be marked used.
    const rows = await tokenRowsFor(user.id);
    expect(rows[0]!.usedAt).toBeNull();
  });

  it("invalid, expired and used tokens answer identically (no enumeration)", async () => {
    const user = await makeUser("reset-generic@example.com");
    const usedToken = await createResetToken(user.id);
    await resetPassword(usedToken);

    const expiredToken = await createResetToken(user.id);
    await db
      .update(resetTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(resetTokens.userId, user.id));

    const responses = await Promise.all([
      resetPassword("garbage-token-not-real"),
      resetPassword(usedToken, "another-password-789"),
      resetPassword(expiredToken),
    ]);
    for (const r of responses) {
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: "Invalid or expired token" });
    }
  });

  it("a completed reset invalidates every existing session for that user", async () => {
    const user = await makeUser("reset-sessions@example.com");
    const firstCookie = await loginCookie(user.email, password);
    const secondCookie = await loginCookie(user.email, password);
    expect(secondCookie).not.toBe(firstCookie);

    expect((await request("/auth/me", { cookie: firstCookie })).status).toBe(200);
    expect((await request("/auth/me", { cookie: secondCookie })).status).toBe(200);

    const token = await createResetToken(user.id);
    expect((await resetPassword(token)).status).toBe(200);

    // Both cookies are dead now.
    expect((await request("/auth/me", { cookie: firstCookie })).status).toBe(401);
    expect((await request("/auth/me", { cookie: secondCookie })).status).toBe(401);
    // And the sessions table has no rows left for the user.
    const rows = await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, user.id));
    expect(rows).toHaveLength(0);

    const audit = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "password_reset_completed"));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.userId).toBe(user.id);
  });

  it("the new password works and the old one no longer does", async () => {
    const user = await makeUser("reset-rotate@example.com");
    const token = await createResetToken(user.id);
    expect((await resetPassword(token)).status).toBe(200);

    const oldLogin = await request("/auth/login", {
      method: "POST",
      body: { email: user.email, password },
    });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request("/auth/login", {
      method: "POST",
      body: { email: user.email, password: newPassword },
    });
    expect(newLogin.status).toBe(200);
  });

  it("rejects a new password shorter than 12 characters without consuming the token", async () => {
    const user = await makeUser("reset-short@example.com");
    const token = await createResetToken(user.id);

    const res = await resetPassword(token, "short");
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("Invalid input");

    const rows = await tokenRowsFor(user.id);
    expect(rows[0]!.usedAt).toBeNull();
  });

  it("rejects a reset with a missing or empty token", async () => {
    const res = await request("/auth/reset-password", {
      method: "POST",
      body: { token: "", newPassword },
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("Invalid input");
  });
});
