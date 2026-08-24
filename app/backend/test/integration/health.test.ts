import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../../src/db/client";
import { schedules } from "../../src/db/schema";
import { registerSchedule, unregisterSchedule } from "../../src/services/scheduler";
import {
  closeTestServer,
  createUser,
  request,
  resetDatabase,
  setupDatabase,
  startTestServer,
} from "./harness";

// 12A — /health tells the truth. The whole gate: status is DERIVED (not the
// hardcoded "ok" the old endpoint returned), a failing check responds 503, and
// a backend that registered zero cron schedules while users have enabled
// schedules in the DB reports degraded. Also: no emails / no secrets in the
// body.

describe("GET /health", () => {
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

  it("healthy: 200, status ok, scheduler.registered matches enabled schedules", async () => {
    const { user } = await createUser();

    // One user with an enabled schedule IN THE DB, and the same schedule
    // REGISTERED in the process (as loadAllSchedules would at boot).
    await db.insert(schedules).values({
      userId: user.id,
      clockInTime: "05:30:00",
      clockOutTime: "18:05:00",
      enabled: true,
    });
    const [row] = await db
      .select()
      .from(schedules)
      .where(eq(schedules.userId, user.id))
      .limit(1);
    registerSchedule(row!);

    try {
      const res = await request("/health");
      expect(res.status).toBe(200);
      const body = res.body as {
        status: string;
        db: string;
        scheduler: {
          registered: number;
          enabledInDb: number;
          registeredMatchesEnabled: boolean;
        };
        queue: { active: number; waiting: number; cap: number };
      };
      expect(body.status).toBe("ok");
      expect(body.db).toBe("ok");
      expect(body.scheduler.registered).toBe(1);
      expect(body.scheduler.enabledInDb).toBe(1);
      expect(body.scheduler.registeredMatchesEnabled).toBe(true);
      // The run queue exists and reports sane shape.
      expect(body.queue.cap).toBeGreaterThan(0);
    } finally {
      unregisterSchedule(user.id);
    }
  });

  it("enabled schedules in DB but nothing registered -> 503 degraded", async () => {
    const { user } = await createUser();
    // Enabled schedule in the DB, but we NEVER register it in the process —
    // the exact "backend booted but cron is dead" failure.
    await db.insert(schedules).values({
      userId: user.id,
      clockInTime: "05:30:00",
      clockOutTime: "18:05:00",
      enabled: true,
    });

    const res = await request("/health");
    expect(res.status).toBe(503);
    const body = res.body as { status: string; scheduler: { registered: number; enabledInDb: number; registeredMatchesEnabled: boolean } };
    expect(body.status).toBe("degraded");
    expect(body.scheduler.registered).toBe(0);
    expect(body.scheduler.enabledInDb).toBe(1);
    expect(body.scheduler.registeredMatchesEnabled).toBe(false);
  });

  it("no schedules anywhere -> healthy 200 (vacuous match)", async () => {
    const res = await request("/health");
    expect(res.status).toBe(200);
    const body = res.body as { status: string; scheduler: { registered: number; enabledInDb: number; registeredMatchesEnabled: boolean } };
    expect(body.status).toBe("ok");
    expect(body.scheduler.registered).toBe(0);
    expect(body.scheduler.enabledInDb).toBe(0);
    expect(body.scheduler.registeredMatchesEnabled).toBe(true);
  });

  it("response body leaks no email and no secret", async () => {
    await createUser({ email: "leakcheck@example.com", password: "supersecret-password-1234" });
    const res = await request("/health");
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/leakcheck@example\.com/);
    expect(text).not.toMatch(/supersecret-password-1234/);
    expect(text).not.toMatch(/@example\.com/);
  });

  // MUST run last: it ends the shared pool. No test may run after this one in
  // this file (vitest runs `it` blocks in declaration order).
  it("dead database -> 503 degraded with db: down (fails against old hardcoded-ok code)", async () => {
    // Kill the pool so any query rejects. This is the historical case that
    // reported healthy: a backend whose only honest field said "down" still
    // answered HTTP 200 {"status":"ok"}.
    await pool.end();

    const res = await request("/health");
    expect(res.status).toBe(503);
    const body = res.body as { status: string; db: string };
    expect(body.status).toBe("degraded");
    expect(body.db).toBe("down");
  });
});
