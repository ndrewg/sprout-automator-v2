import { eq, lt } from "drizzle-orm";
import { db } from "../db/client";
import { sessions, type Session } from "../db/schema";

// 30-day absolute TTL, plus a 7-day idle timeout (§4B.4): a session dies at
// whichever comes first — 30 days since creation, or 7 days since it was last
// used. Both are enforced in findValidSession below.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function createSession(params: {
  userId: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<Session> {
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const [row] = await db
    .insert(sessions)
    .values({
      userId: params.userId,
      expiresAt,
      ip: params.ip ?? null,
      userAgent: params.userAgent ?? null,
    })
    .returning();
  if (!row) throw new Error("createSession: insert returned no row");
  return row;
}

export async function findValidSession(
  sessionId: string,
): Promise<Session | null> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row) return null;

  if (row.expiresAt.getTime() <= Date.now()) {
    // Expired — delete and treat as no session.
    await deleteSession(sessionId);
    return null;
  }

  // Idle timeout (4B.4): a session unused for 7 days is dead even though its
  // absolute TTL hasn't elapsed. Deleted, so the row can't be resurrected.
  if (Date.now() - row.lastUsedAt.getTime() > SESSION_IDLE_TTL_MS) {
    await deleteSession(sessionId);
    return null;
  }

  // Best-effort sliding "last used" bump; must never fail the request.
  try {
    await db
      .update(sessions)
      .set({ lastUsedAt: new Date() })
      .where(eq(sessions.id, sessionId));
  } catch {
    // ignore — purely informational
  }

  return row;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

export async function purgeExpiredSessions(): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date()))
    .returning({ id: sessions.id });
  return deleted.length;
}
