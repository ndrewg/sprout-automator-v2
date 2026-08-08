import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client";
import { auditLog, resetTokens, users } from "../../src/db/schema";
import { hashPassword } from "../../src/lib/passwords";
import { generateRawToken, hashToken } from "../../src/lib/reset-tokens";
import {
  closeTestServer,
  createUser,
  request,
  resetDatabase,
  setupDatabase,
  startTestServer,
} from "./harness";

// 4B.2 email verification. Signup mints a `verify` token (24 h) and emails the
// link; GET/POST /auth/verify complete it. The raw token is only ever emailed,
// never stored or returned — so the endpoints are exercised with tokens
// inserted directly (hash + purpose, exactly as the app stores them), while
// signup is asserted to have minted a properly-shaped row. Every response is
// generic: invalid / expired / used are indistinguishable.
//
// Most users are created straight in the DB (hashPassword is the real Argon2
// function) instead of through POST /auth/signup: signup shares the in-memory
// 10/15min authLimiter with every other auth path. The cookie-dependent tests
// (me, resend) must go through the real route and rely on resetDatabase()'s
// per-test limiter reset.

// Fixture only — must be >=12 chars to clear the signup schema. Not a secret.
const password = "verification-pass-1234"; // gitleaks:allow

async function makeUser(email: string): Promise<{ id: string; email: string }> {
  const passwordHash = await hashPassword(password);
  const [u] = await db.insert(users).values({ email, passwordHash }).returning();
  if (!u) throw new Error("makeUser: insert returned no row");
  return { id: u.id, email: u.email };
}

// Insert a single-use verify token exactly as the app would: only the SHA-256
// hash is stored, purpose "verify", 24 h (or already-expired) validity.
async function makeVerifyToken(
  userId: string,
  opts?: { expired?: boolean },
): Promise<string> {
  const raw = generateRawToken();
  const expiresAt = opts?.expired
    ? new Date(Date.now() - 60 * 1000)
    : new Date(Date.now() + 24 * 60 * 60 * 1000);
  await db.insert(resetTokens).values({
    userId,
    tokenHash: hashToken(raw),
    purpose: "verify",
    expiresAt,
  });
  return raw;
}

async function postVerify(token: string) {
  return request("/auth/verify", { method: "POST", body: { token } });
}

describe("email verification (§4B.2)", () => {
  beforeAll(async () => {
    await setupDatabase();
    await startTestServer();
  });
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await closeTestServer();
  });

  it("signup mints a verify token with a 24h expiry and a null emailVerifiedAt", async () => {
    const { user } = await createUser();
    expect(user.emailVerifiedAt).toBeNull();

    const rows = await db
      .select()
      .from(resetTokens)
      .where(eq(resetTokens.userId, user.id));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.purpose).toBe("verify");
    expect(row.usedAt).toBeNull();
    // SHA-256 hex, never the base64url raw value.
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    // ~24 hours, never beyond.
    const msLeft = row.expiresAt.getTime() - Date.now();
    expect(msLeft).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(msLeft).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 5000);
  });

  it("POST /auth/verify sets email_verified_at, marks the token used, and audits email_verified", async () => {
    const user = await makeUser("verify-success@example.com");
    const token = await makeVerifyToken(user.id);

    const res = await postVerify(token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const [row] = await db
      .select()
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    expect(row!.emailVerifiedAt).not.toBeNull();

    const tokenRows = await db
      .select()
      .from(resetTokens)
      .where(eq(resetTokens.userId, user.id));
    expect(tokenRows[0]!.usedAt).not.toBeNull();

    const audit = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "email_verified"));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.userId).toBe(user.id);
  });

  it("GET /auth/verify?token=… completes the same way", async () => {
    const user = await makeUser("verify-get@example.com");
    const token = await makeVerifyToken(user.id);

    const res = await request(`/auth/verify?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const [row] = await db
      .select()
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    expect(row!.emailVerifiedAt).not.toBeNull();
  });

  it("a used verify token cannot be reused", async () => {
    const user = await makeUser("verify-reuse@example.com");
    const token = await makeVerifyToken(user.id);

    expect((await postVerify(token)).status).toBe(200);
    const second = await postVerify(token);
    expect(second.status).toBe(400);
    expect(second.body).toEqual({ error: "Invalid or expired link" });
  });

  it("an expired verify token is rejected and left unmarked", async () => {
    const user = await makeUser("verify-expired@example.com");
    const token = await makeVerifyToken(user.id, { expired: true });

    const res = await postVerify(token);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid or expired link" });

    // Rejected before the single-use claim — the row must not be marked used.
    const rows = await db
      .select()
      .from(resetTokens)
      .where(eq(resetTokens.userId, user.id));
    expect(rows[0]!.usedAt).toBeNull();
  });

  it("invalid, expired and used tokens answer identically (no enumeration)", async () => {
    const user = await makeUser("verify-generic@example.com");
    const used = await makeVerifyToken(user.id);
    await postVerify(used);
    const expired = await makeVerifyToken(user.id, { expired: true });

    const responses = await Promise.all([
      postVerify("not-a-real-token"),
      postVerify(used),
      postVerify(expired),
    ]);
    for (const r of responses) {
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: "Invalid or expired link" });
    }
  });

  it("a verify token cannot be spent on the reset endpoint, nor a reset token on verify", async () => {
    const user = await makeUser("verify-cross@example.com");
    const verifyToken = await makeVerifyToken(user.id);
    const resetRaw = generateRawToken();
    await db.insert(resetTokens).values({
      userId: user.id,
      tokenHash: hashToken(resetRaw),
      purpose: "reset",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    // Verify token against the password-reset endpoint: purpose mismatch.
    const resetRes = await request("/auth/reset-password", {
      method: "POST",
      body: { token: verifyToken, newPassword: "brand-new-password-456" },
    });
    expect(resetRes.status).toBe(400);
    expect(resetRes.body).toEqual({ error: "Invalid or expired token" });

    // Reset token against the verify endpoint: purpose mismatch.
    const verifyRes = await postVerify(resetRaw);
    expect(verifyRes.status).toBe(400);
    expect(verifyRes.body).toEqual({ error: "Invalid or expired link" });

    // Neither token was consumed.
    const rows = await db
      .select()
      .from(resetTokens)
      .where(eq(resetTokens.userId, user.id));
    for (const r of rows) {
      expect(r.usedAt).toBeNull();
    }
  });

  it("GET /auth/me surfaces emailVerifiedAt: null before, a timestamp after", async () => {
    const { user, cookie } = await createUser();
    const before = await request("/auth/me", { cookie });
    expect(before.status).toBe(200);
    expect(
      (before.body as { user: { emailVerifiedAt: string | null } }).user
        .emailVerifiedAt,
    ).toBeNull();

    const token = await makeVerifyToken(user.id);
    expect((await postVerify(token)).status).toBe(200);

    const after = await request("/auth/me", { cookie });
    expect(after.status).toBe(200);
    const at = (after.body as { user: { emailVerifiedAt: string | null } }).user
      .emailVerifiedAt;
    expect(typeof at).toBe("string");
    expect(new Date(at as string).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("POST /auth/verify/resend mints a fresh verify token", async () => {
    const { user, cookie } = await createUser();
    const before = await db
      .select()
      .from(resetTokens)
      .where(eq(resetTokens.userId, user.id));
    expect(before).toHaveLength(1);

    const res = await request("/auth/verify/resend", {
      cookie,
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const after = await db
      .select()
      .from(resetTokens)
      .where(eq(resetTokens.userId, user.id));
    expect(after).toHaveLength(2);
    for (const r of after) {
      expect(r.purpose).toBe("verify");
      expect(r.usedAt).toBeNull();
    }
  });

  it("resend requires authentication", async () => {
    const res = await request("/auth/verify/resend", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("resend for an already-verified account is a no-op that still answers 200", async () => {
    const { user, cookie } = await createUser();
    const token = await makeVerifyToken(user.id);
    await postVerify(token);

    const before = await db
      .select()
      .from(resetTokens)
      .where(eq(resetTokens.userId, user.id));
    const res = await request("/auth/verify/resend", {
      cookie,
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const after = await db
      .select()
      .from(resetTokens)
      .where(eq(resetTokens.userId, user.id));
    expect(after).toHaveLength(before.length);
  });

  it("the verify endpoints are covered by authLimiter", async () => {
    const user = await makeUser("verify-limit@example.com");
    const token = await makeVerifyToken(user.id);

    const getRes = await request(`/auth/verify?token=${encodeURIComponent(token)}`);
    expect(
      getRes.headers.get("ratelimit-policy"),
      "/auth/verify (GET) is not rate limited",
    ).toBe("10;w=900");

    const resendRes = await request("/auth/verify/resend", {
      method: "POST",
    });
    expect(
      resendRes.headers.get("ratelimit-policy"),
      "/auth/verify/resend is not rate limited",
    ).toBe("10;w=900");
  });
});
