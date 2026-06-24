import { createHash, randomBytes } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client";
import { users, type User } from "../db/schema";
import { hashPassword, verifyPassword } from "../lib/passwords";
import { createSession, deleteSession } from "../lib/sessions";
import { setSessionCookie, clearSessionCookie } from "../lib/cookies";
import { recordAudit } from "../lib/audit";
import { requireAuth } from "../middleware/auth";

export const authRouter = Router();

// Trim + lowercase the email before validating so lookups are case-insensitive.
const credentialsSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(12).max(200),
  })
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

function publicUser(u: User): { id: string; email: string; isAdmin: boolean } {
  return { id: u.id, email: u.email, isAdmin: u.isAdmin };
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

authRouter.post("/signup", async (req: Request, res: Response) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const { email, password } = parsed.data;
  const passwordHash = await hashPassword(password);
  const { ip, userAgent } = clientInfo(req);

  try {
    const [u] = await db.insert(users).values({ email, passwordHash }).returning();
    if (!u) throw new Error("signup: insert returned no row");
    const session = await createSession({ userId: u.id, ip, userAgent });
    setSessionCookie(res, session.id);
    await recordAudit("signup", { userId: u.id, ip, userAgent });
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

authRouter.get("/me", requireAuth, (req: Request, res: Response) => {
  // requireAuth guarantees req.user is set.
  res.json({ user: publicUser(req.user!) });
});
