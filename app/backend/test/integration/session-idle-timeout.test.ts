import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client";
import { sessions } from "../../src/db/schema";
import {
  closeTestServer,
  createUser,
  request,
  resetDatabase,
  setupDatabase,
  startTestServer,
} from "./harness";

// 4B.4 idle session timeout: a session is dead when now - lastUsedAt > 7 days,
// on top of the existing 30-day absolute TTL. The row is deleted so it cannot
// be resurrected. Sessions used within the window keep working (and their
// lastUsedAt bumps, but that is internal).

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("idle session timeout (§4B.4)", () => {
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

  async function ageSession(sessionId: string, ageMs: number): Promise<void> {
    await db
      .update(sessions)
      .set({ lastUsedAt: new Date(Date.now() - ageMs) })
      .where(eq(sessions.id, sessionId));
  }

  // The sid cookie is signed (s:<uuid>.<hmac>), so resolve the session id from
  // the DB via the user we just created instead of parsing the cookie.
  async function sessionIdFor(userId: string): Promise<string> {
    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .limit(1);
    if (!row) throw new Error("no session row for user");
    return row.id;
  }

  it("rejects a session idle past 7 days and deletes the row", async () => {
    const { user, cookie } = await createUser();
    const sessionId = await sessionIdFor(user.id);
    await ageSession(sessionId, 8 * DAY);

    const res = await request("/auth/me", { cookie });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Not authenticated" });

    const rows = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(rows).toHaveLength(0);
  });

  it("accepts a session used 6 days ago (inside the 7-day window)", async () => {
    const { user, cookie } = await createUser();
    const sessionId = await sessionIdFor(user.id);
    await ageSession(sessionId, 6 * DAY);

    const res = await request("/auth/me", { cookie });
    expect(res.status).toBe(200);
  });

  it("boundary: 7 days plus 1 second is expired", async () => {
    const { user, cookie } = await createUser();
    const sessionId = await sessionIdFor(user.id);
    await ageSession(sessionId, 7 * DAY + 1000);
    expect((await request("/auth/me", { cookie })).status).toBe(401);
  });

  it("boundary: 7 days minus 1 second is still valid", async () => {
    const { user, cookie } = await createUser();
    const sessionId = await sessionIdFor(user.id);
    await ageSession(sessionId, 7 * DAY - 1000);
    expect((await request("/auth/me", { cookie })).status).toBe(200);
  });

  it("the absolute 30-day TTL still applies independently of idle time", async () => {
    const { user, cookie } = await createUser();
    const sessionId = await sessionIdFor(user.id);
    // Used 1 minute ago (well inside idle) but past its absolute expiry.
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.id, sessionId));

    const res = await request("/auth/me", { cookie });
    expect(res.status).toBe(401);
  });
});
