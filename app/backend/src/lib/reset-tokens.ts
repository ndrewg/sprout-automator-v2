import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { resetTokens } from "../db/schema";

// 4B.3 — single-use password reset tokens. The raw value (32 bytes, base64url)
// is emailed in the link; only its SHA-256 hash is stored. SHA-256 is
// appropriate here because the raw token already has 256 bits of entropy — no
// need for the memory-hard Argon2 used on passwords.

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function generateRawToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Creates a reset token for the user and returns the RAW value to email. Only
 * the hash is persisted.
 */
export async function createResetToken(userId: string): Promise<string> {
  const raw = generateRawToken();
  await db.insert(resetTokens).values({
    userId,
    tokenHash: hashToken(raw),
    purpose: "reset",
    expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
  });
  return raw;
}

/**
 * Validates and atomically claims a single-use reset token. Returns the owning
 * user's id on success, null for unknown / expired / already-used. The "used"
 * flip is an UPDATE ... WHERE used_at IS NULL, so two concurrent requests with
 * the same token cannot both pass — the database decides, not a check-then-set.
 */
export async function consumeResetToken(raw: string): Promise<string | null> {
  const tokenHash = hashToken(raw);
  const [row] = await db
    .select()
    .from(resetTokens)
    .where(eq(resetTokens.tokenHash, tokenHash))
    .limit(1);
  if (!row) return null;
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
