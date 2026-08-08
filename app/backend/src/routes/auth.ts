import { createHash, randomBytes } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { config } from "../config";
import { db } from "../db/client";
import { runs, sessions, users, type User } from "../db/schema";
import { hashPassword, verifyPassword } from "../lib/passwords";
import { createSession, deleteSession } from "../lib/sessions";
import { setSessionCookie, clearSessionCookie } from "../lib/cookies";
import { recordAudit } from "../lib/audit";
import { sendMail } from "../lib/mailer";
import {
  consumeResetToken,
  createResetToken,
  createVerifyToken,
} from "../lib/reset-tokens";
import {
  isEmailAllowed,
  parseSignupAllowlist,
} from "../lib/signup-allowlist";
import { requireAuth } from "../middleware/auth";
import { unregisterSchedule } from "../services/scheduler";
import { removeUserData } from "../lib/paths";

export const authRouter = Router();

// Trim + lowercase the email before validating so lookups are case-insensitive.
const credentialsSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(12).max(200),
  })
  .strict();

// 4B.3 — password reset. Same min-12 password rule as signup.
const forgotPasswordSchema = z
  .object({ email: z.string().trim().toLowerCase().email().max(254) })
  .strict();

const resetPasswordSchema = z
  .object({
    token: z.string().min(1).max(300),
    newPassword: z.string().min(12).max(200),
  })
  .strict();

// 4B.2 — email verification token.
const verifySchema = z.object({ token: z.string().min(1).max(300) }).strict();

// 4B.5 — account deletion re-confirms the current password.
const deleteAccountSchema = z
  .object({ password: z.string().min(1).max(200) })
  .strict();

// Dummy Argon2id hash for timing-equalization on nonexistent users — verifying
// against it costs the same as a real verify, so login timing doesn't leak
// whether an email exists. It MUST be a real hash (same params) so verify()
// actually performs the memory-hard work; a hand-written/invalid encoded hash
// makes verify() reject instantly and reintroduces the timing side-channel.
// Computed once at module load from a throwaway random secret.
const dummyHashPromise: Promise<string> = hashPassword(
  randomBytes(32).toString("hex"),
);

function publicUser(u: User): {
  id: string;
  email: string;
  isAdmin: boolean;
  emailVerifiedAt: string | null;
} {
  return {
    id: u.id,
    email: u.email,
    isAdmin: u.isAdmin,
    emailVerifiedAt: u.emailVerifiedAt ? u.emailVerifiedAt.toISOString() : null,
  };
}

function emailHash(email: string): string {
  // Non-reversible, truncated — for correlating failed logins without storing
  // the email itself.
  return createHash("sha256").update(email).digest("hex").slice(0, 16);
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}

function clientInfo(req: Request): { ip: string | null; userAgent: string | null } {
  return { ip: req.ip ?? null, userAgent: req.get("user-agent") ?? null };
}

// The emailed verification link. Purpose-built path /verify?token=… (NOT an API
// path) so the SPA catch-all serves the verify screen, exactly like /reset.
async function sendVerificationEmail(email: string, token: string): Promise<void> {
  const verifyUrl = `${config.APP_URL}/verify?token=${encodeURIComponent(token)}`;
  await sendMail({
    to: email,
    subject: "Verify your email address",
    html:
      `<p>Welcome to Sprout Automator!</p>` +
      `<p>Confirm this address by clicking the link below:</p>` +
      `<p><a href="${verifyUrl}">Verify your email</a></p>` +
      `<p>This link expires in 24 hours. If you didn't create an account, ` +
      `you can ignore this email.</p>`,
  });
}

authRouter.post("/signup", async (req: Request, res: Response) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const { email, password } = parsed.data;
  const { ip, userAgent } = clientInfo(req);

  // 4A.2 signup gating — the email allowlist. Rejects BEFORE the password
  // hash. The response is the same generic message regardless of cause so it
  // never reveals the allowlist contents; the audit trail records only a
  // non-reversible emailHash (never the email), mirroring login_failure. An
  // empty allowlist (dev without SIGNUP_ALLOWED) means signup is open.
  const signupAllowlist = parseSignupAllowlist(config.SIGNUP_ALLOWED);
  if (signupAllowlist.length > 0 && !isEmailAllowed(email, signupAllowlist)) {
    await recordAudit("signup_rejected", {
      ip,
      userAgent,
      metadata: { emailHash: emailHash(email) },
    });
    res.status(403).json({ error: "Signup is not open." });
    return;
  }

  const passwordHash = await hashPassword(password);

  try {
    const [u] = await db.insert(users).values({ email, passwordHash }).returning();
    if (!u) throw new Error("signup: insert returned no row");
    const session = await createSession({ userId: u.id, ip, userAgent });
    setSessionCookie(res, session.id);
    await recordAudit("signup", { userId: u.id, ip, userAgent });

    // 4B.2 — mint a verify token and email the link. Best-effort: a dead mail
    // provider (or a transient token-insert failure) must not break signup, so
    // the account exists — and stays functional, verification is NOT enforced
    // in this build — even if the email never lands.
    try {
      const verifyToken = await createVerifyToken(u.id);
      await sendVerificationEmail(u.email, verifyToken);
    } catch (err: unknown) {
      req.log.error({ err }, "signup: verification email send failed");
    }

    res.status(201).json({ user: publicUser(u) });
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: "Email already registered" });
      return;
    }
    throw err;
  }
});

authRouter.post("/login", async (req: Request, res: Response) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const { email, password } = parsed.data;
  const { ip, userAgent } = clientInfo(req);

  const [u] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);

  if (!u) {
    // Timing equalization: still run a real verify against the dummy hash.
    await verifyPassword(await dummyHashPromise, password);
    await recordAudit("login_failure", {
      ip,
      userAgent,
      metadata: { emailHash: emailHash(email) },
    });
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const ok = await verifyPassword(u.passwordHash, password);
  if (!ok) {
    await recordAudit("login_failure", {
      userId: u.id,
      ip,
      userAgent,
      metadata: { emailHash: emailHash(email) },
    });
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const session = await createSession({ userId: u.id, ip, userAgent });
  setSessionCookie(res, session.id);
  await recordAudit("login_success", { userId: u.id, ip, userAgent });
  res.status(200).json({ user: publicUser(u) });
});

authRouter.post("/logout", requireAuth, async (req: Request, res: Response) => {
  // requireAuth guarantees req.user / req.sessionId are set.
  const user = req.user!;
  const { ip, userAgent } = clientInfo(req);
  if (req.sessionId) {
    await deleteSession(req.sessionId);
  }
  clearSessionCookie(res);
  await recordAudit("logout", { userId: user.id, ip, userAgent });
  res.json({ ok: true });
});

// 4B.3 — request a password reset. ALWAYS 200, whether or not the account
// exists: the response must never reveal account existence, so a caller cannot
// enumerate the user list through this endpoint. When the account exists a
// single-use token is created and emailed; the mailer logs instead of sending
// in dev (no provider), and the raw token never reaches a log file or the
// audit trail.
authRouter.post("/forgot-password", async (req: Request, res: Response) => {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const { email } = parsed.data;
  const { ip, userAgent } = clientInfo(req);

  const [u] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);

  if (u) {
    const token = await createResetToken(u.id);
    const resetUrl = `${config.APP_URL}/reset?token=${encodeURIComponent(token)}`;
    try {
      await sendMail({
        to: u.email,
        subject: "Reset your Sprout Automator password",
        html:
          `<p>We received a request to reset your password.</p>` +
          `<p><a href="${resetUrl}">Reset your password</a></p>` +
          `<p>This link expires in 1 hour. If you didn't ask for this, ` +
          `ignore this email — your password is unchanged.</p>`,
      });
    } catch (err: unknown) {
      // Best-effort: a dead mail provider must not reveal account existence,
      // so the request still answers 200. The token simply goes unused.
      req.log.error({ err }, "forgot-password: reset email send failed");
    }
    await recordAudit("password_reset_requested", { userId: u.id, ip, userAgent });
  }

  res.status(200).json({ ok: true });
});

// 4B.3 — complete a password reset. The token is validated, single-use, and
// 1-hour-expiring; invalid / expired / already-used all answer with the SAME
// generic message so a token cannot be enumerated or replayed. On success the
// password is re-hashed with Argon2id and EVERY session for the user is
// deleted, so a cookie stolen before the reset dies with it. A token minted
// for another purpose (e.g. verify) is rejected here.
authRouter.post("/reset-password", async (req: Request, res: Response) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const { token, newPassword } = parsed.data;
  const { ip, userAgent } = clientInfo(req);

  const userId = await consumeResetToken(token, "reset");
  if (!userId) {
    res.status(400).json({ error: "Invalid or expired token" });
    return;
  }

  const passwordHash = await hashPassword(newPassword);
  await db
    .update(users)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(users.id, userId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await recordAudit("password_reset_completed", { userId, ip, userAgent });
  res.json({ ok: true });
});

// 4B.2 — complete email verification. Shared by GET (the emailed link could
// hit the API directly) and POST (used by the SPA verify screen). The token is
// validated, single-use, 24-hour-expiring, and purpose-locked to "verify";
// invalid / expired / used answer with the SAME generic message so a token
// cannot be enumerated or replayed. On success email_verified_at is set and
// the token is atomically marked used.
async function handleVerify(
  rawToken: string,
  req: Request,
  res: Response,
): Promise<void> {
  const { ip, userAgent } = clientInfo(req);
  const userId = await consumeResetToken(rawToken, "verify");
  if (!userId) {
    res.status(400).json({ error: "Invalid or expired link" });
    return;
  }
  await db
    .update(users)
    .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, userId));
  await recordAudit("email_verified", { userId, ip, userAgent });
  res.json({ ok: true });
}

authRouter.get("/verify", async (req: Request, res: Response) => {
  const token =
    typeof req.query["token"] === "string" ? req.query["token"] : "";
  await handleVerify(token, req, res);
});

authRouter.post("/verify", async (req: Request, res: Response) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  await handleVerify(parsed.data.token, req, res);
});

// 4B.2 — resend the verification email for the authenticated user. A fresh
// 24-hour token replaces the (possibly lost) one from signup. Already verified
// accounts answer 200 without sending, so the endpoint leaks nothing.
authRouter.post("/verify/resend", requireAuth, async (req: Request, res: Response) => {
  const user = req.user!;
  if (user.emailVerifiedAt) {
    res.json({ ok: true });
    return;
  }
  const token = await createVerifyToken(user.id);
  try {
    await sendVerificationEmail(user.email, token);
  } catch (err: unknown) {
    req.log.error({ err }, "verify-resend: verification email send failed");
  }
  res.json({ ok: true });
});

// 4B.5 — account deletion. Re-confirms the current password, refuses while a
// run is active (a cascade would orphan a live Chromium and an update against a
// deleted row), stops the cron tasks, writes a surviving account_deleted audit
// row BEFORE the delete (the FK is ON DELETE SET NULL, so the trail keeps only
// the non-reversible emailHash), removes the user's filesystem data, and clears
// the session cookie so the browser cannot hold a dead sid.
authRouter.delete("/account", requireAuth, async (req: Request, res: Response) => {
  const user = req.user!;
  const { ip, userAgent } = clientInfo(req);

  const parsed = deleteAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }

  const passwordOk = await verifyPassword(user.passwordHash, parsed.data.password);
  if (!passwordOk) {
    res.status(401).json({ error: "Incorrect password" });
    return;
  }

  // Refuse while a run is pending or running. Simpler and safer than
  // reconciling a cascade out from under a live executor.
  const [activeRun] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.userId, user.id),
        inArray(runs.status, ["pending", "running"]),
      ),
    )
    .limit(1);
  if (activeRun) {
    res.status(409).json({
      error:
        "Cannot delete your account while a run is in progress. Wait for it to finish, then try again.",
    });
    return;
  }

  // Stop the cron tasks before the cascade — the DB cannot reach in-process
  // timers, so unregistering is what keeps a deleted user's schedule from
  // firing a run against no account.
  unregisterSchedule(user.id);

  // Written BEFORE the delete so the row survives with user_id NULL (FK ON
  // DELETE SET NULL). Metadata carries only the non-reversible emailHash —
  // never the address itself.
  await recordAudit("account_deleted", {
    userId: user.id,
    ip,
    userAgent,
    metadata: { emailHash: emailHash(user.email) },
  });

  await db.delete(users).where(eq(users.id, user.id));

  // Best-effort filesystem cleanup: leftover dirs must never fail the request.
  try {
    await removeUserData(user.id);
  } catch (err: unknown) {
    req.log.error(
      { err, userId: user.id },
      "account deletion: failed to remove user data directories",
    );
  }

  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.get("/me", requireAuth, (req: Request, res: Response) => {
  // requireAuth guarantees req.user is set.
  res.json({ user: publicUser(req.user!) });
});
