import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/db/client";
import { auditLog, credentials, runs, schedules } from "../../src/db/schema";
import { encrypt } from "../../src/lib/encryption";
import { manilaDateString } from "../../src/lib/ph-holidays";
import { fireCron } from "../../src/services/scheduler";
import {
  closeTestServer,
  createUser,
  request,
  resetDatabase,
  setupDatabase,
  startTestServer,
} from "./harness";

// Phase 7, gate 7A. Three distinct behaviours, all through the real stack:
//  1. fireCron creates no run while the pause window covers the fire date.
//  2. PUT /schedule validates the pair (both-or-neither, ordered, not already
//     over) and round-trips pausedFrom/pausedUntil/pausedToday on GET.
//  3. A manual POST /runs is NOT blocked by a pause — pausing suppresses
//     automation, not the user.
// The fireCron tests need real credentials in the DB so that removing the pause
// skip would actually create a run (startRun bails early on missing creds).

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

describe("schedule pause (phase 7)", () => {
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

  async function userWithPauseRow(opts?: {
    pausedFrom: string;
    pausedUntil: string;
  }): Promise<{ userId: string }> {
    const { user } = await createUser();
    await db.insert(credentials).values({
      userId: user.id,
      sproutUsernameEnc: encrypt("e2e-sprout-user"),
      sproutPasswordEnc: encrypt("e2e-sprout-password"),
    });
    await db.insert(schedules).values({
      userId: user.id,
      clockInTime: "05:30:00",
      clockOutTime: "18:05:00",
      enabled: true,
      pausedFrom: opts?.pausedFrom ?? null,
      pausedUntil: opts?.pausedUntil ?? null,
    });
    return { userId: user.id };
  }

  describe("fireCron", () => {
    const FIRE_AT = new Date("2026-08-12T04:00:00Z"); // noon Manila, Wed

    it("creates no run while the pause window covers the fire date", async () => {
      const { userId } = await userWithPauseRow({
        pausedFrom: "2026-08-10",
        pausedUntil: "2026-08-14",
      });

      await fireCron(userId, "in", FIRE_AT);
      expect(await db.$count(runs)).toBe(0);
      // The out action is suppressed the same way.
      await fireCron(userId, "out", FIRE_AT);
      expect(await db.$count(runs)).toBe(0);
    });

    it("creates a run when the pause window does not cover the fire date (positive control)", async () => {
      // No pause row at all — proves the test above would fail without the skip
      // (i.e. it is not vacuously green because of missing credentials).
      const { userId } = await userWithPauseRow({
        pausedFrom: "2026-08-17",
        pausedUntil: "2026-08-21",
      });

      await fireCron(userId, "in", FIRE_AT);
      expect(await db.$count(runs)).toBe(1);
    });
  });

  describe("PUT /schedule pause validation", () => {
    it("rejects malformed pairs: one-sided, one-null, reversed, already-ended, bad format", async () => {
      const { cookie } = await createUser();
      const today = manilaDateString(new Date());
      const cases: { body: Record<string, unknown>; error: string }[] = [
        { body: { pausedFrom: today }, error: "Provide both pausedFrom and pausedUntil, or neither." },
        { body: { pausedUntil: addDays(today, 1) }, error: "Provide both pausedFrom and pausedUntil, or neither." },
        { body: { pausedFrom: null, pausedUntil: addDays(today, 1) }, error: "Provide both pausedFrom and pausedUntil, or neither." },
        { body: { pausedFrom: addDays(today, 3), pausedUntil: today }, error: "pausedUntil must be on or after pausedFrom" },
        { body: { pausedFrom: addDays(today, -3), pausedUntil: addDays(today, -1) }, error: "That pause window has already ended." },
        { body: { pausedFrom: "08/10/2026", pausedUntil: "08/12/2026" }, error: "Invalid input" },
      ];
      // None of these mutate the row, so one user serves all six checks.
      for (const c of cases) {
        const res = await request("/schedule", {
          cookie,
          method: "PUT",
          body: c.body,
        });
        expect(res.status).toBe(400);
        expect((res.body as { error: string }).error).toBe(c.error);
      }
      // And the schedule row is untouched — no pause was ever stored.
      const get = await request("/schedule", { cookie });
      const view = (get.body as { schedule: Record<string, unknown> }).schedule;
      expect(view["pausedFrom"]).toBeNull();
      expect(view["pausedUntil"]).toBeNull();
      expect(view["pausedToday"]).toBe(false);
    });
  });

  describe("GET /schedule pause surface", () => {
    it("round-trips a valid window and reports pausedToday:true", async () => {
      const { cookie } = await createUser();
      const today = manilaDateString(new Date());
      const until = addDays(today, 3);
      const put = await request("/schedule", {
        cookie,
        method: "PUT",
        body: { pausedFrom: today, pausedUntil: until },
      });
      expect(put.status).toBe(200);
      const putView = (put.body as { schedule: Record<string, unknown> })
        .schedule;
      expect(putView["pausedFrom"]).toBe(today);
      expect(putView["pausedUntil"]).toBe(until);
      expect(putView["pausedToday"]).toBe(true);

      const get = await request("/schedule", { cookie });
      const view = (get.body as { schedule: Record<string, unknown> }).schedule;
      expect(view["pausedFrom"]).toBe(today);
      expect(view["pausedUntil"]).toBe(until);
      expect(view["pausedToday"]).toBe(true);
    });

    it("a fresh user has no pause and pausedToday:false", async () => {
      const { cookie } = await createUser();
      const res = await request("/schedule", { cookie });
      expect(res.status).toBe(200);
      const view = (res.body as { schedule: Record<string, unknown> }).schedule;
      expect(view["pausedFrom"]).toBeNull();
      expect(view["pausedUntil"]).toBeNull();
      expect(view["pausedToday"]).toBe(false);
    });

    it("a window that has already ended reports pausedToday:false (auto-expires)", async () => {
      const { user, cookie } = await createUser();
      const today = manilaDateString(new Date());
      // Expired windows cannot be PUT (rejected as already over), so update the
      // row directly — exactly the state the DB is in after time passes.
      await request("/schedule", {
        cookie,
        method: "PUT",
        body: { pausedFrom: today, pausedUntil: today },
      });
      await db
        .update(schedules)
        .set({
          pausedFrom: addDays(today, -2),
          pausedUntil: addDays(today, -1),
        })
        .where(eq(schedules.userId, user.id));

      const get = await request("/schedule", { cookie });
      const view = (get.body as { schedule: Record<string, unknown> }).schedule;
      expect(view["pausedFrom"]).toBe(addDays(today, -2));
      expect(view["pausedUntil"]).toBe(addDays(today, -1));
      expect(view["pausedToday"]).toBe(false);
    });

    it("PUT with both null clears an active pause", async () => {
      const { cookie } = await createUser();
      const today = manilaDateString(new Date());
      await request("/schedule", {
        cookie,
        method: "PUT",
        body: { pausedFrom: today, pausedUntil: addDays(today, 2) },
      });

      const clear = await request("/schedule", {
        cookie,
        method: "PUT",
        body: { pausedFrom: null, pausedUntil: null },
      });
      expect(clear.status).toBe(200);
      const view = (clear.body as { schedule: Record<string, unknown> })
        .schedule;
      expect(view["pausedFrom"]).toBeNull();
      expect(view["pausedUntil"]).toBeNull();
      expect(view["pausedToday"]).toBe(false);
    });

    it("audits schedule_updated with the pause values (not secrets)", async () => {
      const { user, cookie } = await createUser();
      const today = manilaDateString(new Date());
      const until = addDays(today, 2);
      await request("/schedule", {
        cookie,
        method: "PUT",
        body: { pausedFrom: today, pausedUntil: until },
      });

      const [row] = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.userId, user.id),
            eq(auditLog.eventType, "schedule_updated"),
          ),
        )
        .limit(1);
      const metadata = (row?.metadata ?? {}) as Record<string, unknown>;
      expect(metadata["fields"]).toContain("pausedFrom");
      expect(metadata["pausedFrom"]).toBe(today);
      expect(metadata["pausedUntil"]).toBe(until);
    });
  });

  describe("manual runs while paused", () => {
    it("POST /runs still works while paused (202)", async () => {
      const { cookie } = await createUser();
      const today = manilaDateString(new Date());
      await request("/credentials", {
        cookie,
        method: "PUT",
        body: { sproutUsername: "user-a", sproutPassword: "a-pass-1234" },
      });
      const paused = await request("/schedule", {
        cookie,
        method: "PUT",
        body: { pausedFrom: today, pausedUntil: addDays(today, 2) },
      });
      expect(paused.status).toBe(200);

      const res = await request("/runs", {
        cookie,
        method: "POST",
        body: { action: "in" },
      });
      expect(res.status).toBe(202);
    });
  });
});
