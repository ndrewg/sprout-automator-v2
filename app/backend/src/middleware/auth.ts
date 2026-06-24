import { type Request, type Response, type NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { users, type User } from "../db/schema";
import { findValidSession } from "../lib/sessions";
import { readSessionCookie } from "../lib/cookies";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
      sessionId?: string;
    }
  }
}

/**
 * Runs on every request: if a valid session cookie is present, load the user
 * and attach `req.user` / `req.sessionId`. Never throws — absence of a user is
 * a normal outcome, enforced downstream by `requireAuth`.
 */
export async function attachUser(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const sid = readSessionCookie(req);
    if (sid) {
      const session = await findValidSession(sid);
      if (session) {
        const [u] = await db
          .select()
          .from(users)
          .where(eq(users.id, session.userId))
          .limit(1);
        if (u) {
          req.user = u;
          req.sessionId = session.id;
        }
      }
    }
  } catch (err: unknown) {
    req.log.error({ err }, "attachUser failed");
  }
  next();
}

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  next();
}
