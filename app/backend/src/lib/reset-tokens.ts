import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { resetTokens } from "../db/schema";

// 4B.3/4B.2 — single-use tokens for password reset AND email verification. The
// raw value (32 bytes, base64url) is emailed in the link; only its SHA-256 hash
// is stored. SHA-256 is appropriate here because the raw token already has 256
// bits of entropy — no need for the memory-hard Argon2 used on passwords.
//
// The reset_tokens table is shared by both purposes (purpose column), accepted
// despite the now-misleading table name — a migration for cosmetics is not
// worth it. A token is ONLY redeemable for its own purpose: a verify token
// against the reset endpoint (or vice versa) is rejected.

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
export const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export type TokenPurpose = "reset" | "verify";

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function generateRawToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Creates a single-use token for the user and returns the RAW value to email.
 * Only the hash is persisted. purpose defaults to "reset" (1 h TTL); the verify
 * flow passes purpose "verify" with the 24 h TTL.
 */
export async function createResetToken(
  userId: string,
  opts: { purpose?: TokenPurpose; ttlMs?: number } = {},
): Promise<string> {
  const raw = generateRawToken();
  await db.insert(resetTokens).values({
    userId,
    tokenHash: hashToken(raw),
    purpose: opts.purpose ?? "reset",
    expiresAt: new Date(Date.now() + (opts.ttlMs ?? RESET_TOKEN_TTL_MS)),
  });
  return raw;
}

/** Creates a 24-hour single-use email-verification token. */
export async function createVerifyToken(userId: string): Promise<string> {
  return createResetToken(userId, { purpose: "verify", ttlMs: VERIFY_TOKEN_TTL_MS });
}

/**
 * Validates and atomically claims a single-use token. Returns the owning
 * user's id on success, null for unknown / expired / already-used / WRONG
 * PURPOSE. The "used" flip is an UPDATE ... WHERE used_at IS NULL, so two
 * concurrent requests with the same token cannot both pass — the database
 * decides, not a check-then-set.
 */
export async function consumeResetToken(
  raw: string,
  purpose: TokenPurpose,
): Promise<string | null> {
  const tokenHash = hashToken(raw);
  const [row] = await db
    .select()
    .from(resetTokens)
    .where(eq(resetTokens.tokenHash, tokenHash))
    .limit(1);
  if (!row) return null;
  if (row.purpose !== purpose) return null;
  if (row.usedAt !== null) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;

  const [claimed] = await db
    .update(resetTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(resetTokens.id, row.id), isNull(resetTokens.usedAt)))
    .returning({ id: resetTokens.id });
  if (!claimed) return null;

  return row.userId;
}
