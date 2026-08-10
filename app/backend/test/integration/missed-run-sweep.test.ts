import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client";
import { missedRunNotices, runs, schedules } from "../../src/db/schema";
import {
  defaultSweepDeps,
  sweepMissedRuns,
} from "../../src/services/notifications";
import {
  closeTestServer,
  createUser,
  resetDatabase,
  setupDatabase,
  startTestServer,
} from "./harness";

// The sweep's idempotency IS the DB unique index (missed_notice_once), so this
// must run against a real database — a fake insert proves nothing. Time,
// workday, and dispatch are injected; everything that touches the DB
// (schedules, the run lookup, the onConflictDoNothing insert) is real.
const FIXED_NOW = new Date("2026-08-10T06:10:00+08:00"); // Monday; the 05:30 in-run is 40min past

describe("missed-run reconciliation sweep", () => {
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

  async function userWithSchedule(): Promise<{ userId: string }> {
    const { user } = await createUser();
    await db.insert(schedules).values({
      userId: user.id,
      clockInTime: "05:30:00",
      clockOutTime: "18:05:00",
      enabled: true,
    });
    return { userId: user.id };
  }

  it("misses the in-run and dispatches exactly once across two sweeps", async () => {
    const { userId } = await userWithSchedule();
    const sent: string[] = [];
    const deps = {
      ...defaultSweepDeps,
      now: () => FIXED_NOW,
      isWorkday: () => true,
      dispatchMissed: async (_uid: string, html: string) => {
        sent.push(html);
        return "sent" as const;
      },
    };

    await sweepMissedRuns(deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Clock-in did not run");
    expect(
      await db.$count(missedRunNotices, eq(missedRunNotices.userId, userId)),
    ).toBe(1);

    // The unique index, not application logic, prevents a duplicate send.
    await sweepMissedRuns(deps);
    expect(sent).toHaveLength(1);
    expect(
      await db.$count(missedRunNotices, eq(missedRunNotices.userId, userId)),
    ).toBe(1);
  });

  it("a run on today's Manila date (any status, even failure) suppresses the notice", async () => {
    const { userId } = await userWithSchedule();
    await db.insert(runs).values({
      userId,
      action: "in",
      status: "failure",
      startedAt: new Date("2026-08-10T05:31:00+08:00"),
      error: "Login failed",
    });
    const sent: string[] = [];
    const deps = {
      ...defaultSweepDeps,
      now: () => FIXED_NOW,
      isWorkday: () => true,
      dispatchMissed: async (_uid: string, html: string) => {
        sent.push(html);
        return "sent" as const;
      },
    };

    await sweepMissedRuns(deps);
    expect(sent).toHaveLength(0);
    expect(
      await db.$count(missedRunNotices, eq(missedRunNotices.userId, userId)),
    ).toBe(0);
  });

  it("misses the out-run: alert fires, message says Clock out, notice records action = out", async () => {
    const { userId } = await userWithSchedule();
    // The in-run already happened today, so only the clock-out path is swept.
    await db.insert(runs).values({
      userId,
      action: "in",
      status: "success",
      startedAt: new Date("2026-08-10T05:31:00+08:00"),
    });
    const sent: string[] = [];
    const deps = {
      ...defaultSweepDeps,
      now: () => new Date("2026-08-10T18:45:00+08:00"), // 40min past the 18:05 out
      isWorkday: () => true,
      dispatchMissed: async (_uid: string, html: string) => {
        sent.push(html);
        return "sent" as const;
      },
    };

    await sweepMissedRuns(deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Clock-out did not run");
    expect(sent[0]).toContain("Clock out manually if you haven't already.");

    const [notice] = await db
      .select()
      .from(missedRunNotices)
      .where(eq(missedRunNotices.userId, userId))
      .limit(1);
    expect(notice?.action).toBe("out");
  });

  it("a paused day is not a missed run: neither action alerts", async () => {
    const { userId } = await userWithSchedule();
    // Pause window covers FIXED_NOW (2026-08-10). Without the pause skip the
    // in-run would be 40min overdue and would alert — so an empty `sent` proves
    // the skip, not a missing schedule.
    await db
      .update(schedules)
      .set({ pausedFrom: "2026-08-10", pausedUntil: "2026-08-14" })
      .where(eq(schedules.userId, userId));
    const sent: string[] = [];
    const deps = {
      ...defaultSweepDeps,
      now: () => FIXED_NOW,
      isWorkday: () => true,
      dispatchMissed: async (_uid: string, html: string) => {
        sent.push(html);
        return "sent" as const;
      },
    };

    await sweepMissedRuns(deps);
    expect(sent).toHaveLength(0);
    expect(
      await db.$count(missedRunNotices, eq(missedRunNotices.userId, userId)),
    ).toBe(0);
  });

  it("marks notified_at after a successful send, and a set notified_at never re-dispatches", async () => {
    const { userId } = await userWithSchedule();
    const sent: string[] = [];
    const deps = {
      ...defaultSweepDeps,
      now: () => FIXED_NOW,
      isWorkday: () => true,
      dispatchMissed: async (_uid: string, html: string) => {
        sent.push(html);
        return "sent" as const;
      },
    };

    // First sweep: insert wins → claimed → dispatch sent → notified_at set.
    await sweepMissedRuns(deps);
    expect(sent).toHaveLength(1);
    const [afterFirst] = await db
      .select()
      .from(missedRunNotices)
      .where(eq(missedRunNotices.userId, userId))
      .limit(1);
    expect(afterFirst?.notifiedAt).not.toBeNull();

    // Second sweep: the row exists and is notified → "done" → no dispatch.
    await sweepMissedRuns(deps);
    expect(sent).toHaveLength(1);
  });

  it("a notice row with notified_at NULL (earlier send failed) is retried by the next sweep", async () => {
    const { userId } = await userWithSchedule();
    // Simulates a Telegram outage: the notice row exists from a failed send.
    await db.insert(missedRunNotices).values({
      userId,
      manilaDate: "2026-08-10",
      action: "in",
    });
    const sent: string[] = [];
    const deps = {
      ...defaultSweepDeps,
      now: () => FIXED_NOW,
      isWorkday: () => true,
      dispatchMissed: async (_uid: string, html: string) => {
        sent.push(html);
        return "sent" as const;
      },
    };

    await sweepMissedRuns(deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Clock-in did not run");
    const [notice] = await db
      .select()
      .from(missedRunNotices)
      .where(eq(missedRunNotices.userId, userId))
      .limit(1);
    expect(notice?.notifiedAt).not.toBeNull();
    // Still exactly one row — the retry reused it, it did not double-insert.
    expect(
      await db.$count(missedRunNotices, eq(missedRunNotices.userId, userId)),
    ).toBe(1);
  });

  it("a notice row with notified_at set is never re-dispatched", async () => {
    const { userId } = await userWithSchedule();
    await db.insert(missedRunNotices).values({
      userId,
      manilaDate: "2026-08-10",
      action: "in",
      notifiedAt: new Date("2026-08-10T06:00:00+08:00"),
    });
    const sent: string[] = [];
    const deps = {
      ...defaultSweepDeps,
      now: () => FIXED_NOW,
      isWorkday: () => true,
      dispatchMissed: async (_uid: string, html: string) => {
        sent.push(html);
        return "sent" as const;
      },
    };

    await sweepMissedRuns(deps);
    expect(sent).toHaveLength(0);
  });
});
