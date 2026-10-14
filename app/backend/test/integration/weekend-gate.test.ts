import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client";
import {
  credentials,
  dayOverrides,
  holidaySkipNotices,
  missedRunNotices,
  runs,
  schedules,
} from "../../src/db/schema";
import { encrypt } from "../../src/lib/encryption";
import { schedulerTick } from "../../src/services/scheduler";
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

// Phase 16 review, defect B1. The scheduler, the evening heads-up and the
// missed-run sweep must all agree through the ONE Workday gate.
//
// The bug: `dueSlots` hard-filtered weekends, so on a Saturday the scheduler
// never even asked the gate — a user's "work anyway" override clocked NOBODY in,
// while the sweep (which DID ask the gate) saw a work day with no run and sent a
// false "missed the clock-in" alert. Two failures from one hard-coded filter.
//
// These are the load-bearing proof:
//   5a — a weekend "work anyway" actually clocks in, and sends no false alert;
//   5b — a plain weekend stays completely silent (the fix must not over-reach).
//
// The instants are pinned (no `Date.now()` in what is asserted — BACKLOG §11).
// Sat 2026-10-10 is Manila's weekend; 2026-10-13 is a Tuesday (see
// `services/scheduler.test.ts`), so the Monday before it is 2026-10-12.

const SATURDAY = "2026-10-10";
const FIRE_AT = new Date("2026-10-10T05:30:05+08:00"); // inside the 05:30 window
const SWEEP_AT = new Date("2026-10-10T06:10:00+08:00"); // 40min past — outside the 20min grace

describe("weekend work overrides reach the gate (16 review B1)", () => {
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

  /**
   * A user with an enabled Mon–Fri schedule (05:30 in / 18:05 out) and real —
   * dummy — credentials, so the scheduler's `startRun` can actually create a run.
   */
  async function userWithSchedule(): Promise<{
    userId: string;
    schedule: typeof schedules.$inferSelect;
  }> {
    const { user } = await createUser();
    const [schedule] = await db
      .insert(schedules)
      .values({
        userId: user.id,
        clockInTime: "05:30:00",
        clockOutTime: "18:05:00",
        enabled: true,
      })
      .returning();
    if (!schedule) throw new Error("schedule insert returned no row");
    await db.insert(credentials).values({
      userId: user.id,
      sproutUsernameEnc: encrypt("sprout-user"),
      sproutPasswordEnc: encrypt("sprout-password"),
    });
    return { userId: user.id, schedule };
  }

  it("5a — a Saturday 'work anyway' fires a clock-in and sends no false missed alert", async () => {
    const { userId, schedule } = await userWithSchedule();
    await db.insert(dayOverrides).values({
      userId,
      manilaDate: SATURDAY,
      kind: "work",
      note: "covering for a colleague",
    });

    // ONE tick, at the pinned Saturday instant. `slots` is injected so the tick
    // sees the schedule without touching module-global registration; the tick's
    // own 5-minute sweep is muted so the REAL wall clock cannot write an
    // unrelated notice — the sweep under test is called explicitly below.
    await schedulerTick(FIRE_AT, {
      slots: () => [schedule],
      sweep: async () => {},
    });

    // The gate said WORK (the override), and `dueSlots` yielded the Saturday
    // slot, so a clock-in run exists. Pre-fix this was empty: the weekend filter
    // swallowed the slot before the gate was ever consulted.
    const created = await db.select().from(runs).where(eq(runs.userId, userId));
    expect(created).toHaveLength(1);
    expect(created[0]?.action).toBe("in");

    // The database stamps `started_at` from its OWN clock, which a test cannot
    // pin; the sweep's clock IS pinned, and `hasRunToday` requires the record's
    // Manila date to equal the sweep's `todayStr` (see the note on that dep). So
    // align the record to the pinned instant — exactly what the sweep tests do
    // by inserting `startedAt` explicitly.
    await db
      .update(runs)
      .set({ startedAt: FIRE_AT })
      .where(eq(runs.id, created[0]!.id));

    // The sweep, 40 min later. The gate says WORK (the override), but the run
    // for this slot exists, so nothing was missed. Pre-fix the sweep alerted
    // here — the "false missed-run alert" this defect is about.
    const sent: string[] = [];
    await sweepMissedRuns({
      ...defaultSweepDeps,
      now: () => SWEEP_AT,
      dispatchMissed: async (_uid: string, html: string) => {
        sent.push(html);
        return "sent" as const;
      },
    });
    expect(sent).toHaveLength(0);
    expect(
      await db.$count(missedRunNotices, eq(missedRunNotices.userId, userId)),
    ).toBe(0);
  });

  it("5b — a plain Saturday stays completely silent", async () => {
    const { userId, schedule } = await userWithSchedule();
    // NO override: a normal weekend.

    await schedulerTick(FIRE_AT, {
      slots: () => [schedule],
      sweep: async () => {},
    });

    // The gate says weekend, so no run is created…
    expect(await db.$count(runs, eq(runs.userId, userId))).toBe(0);
    // …and NO skip notice is sent. `notifySkip` refuses a weekend before it
    // inserts the once-per-day row, so not even the idempotency record exists.
    // (The guard returns before any await, so this needs no settling.)
    expect(
      await db.$count(holidaySkipNotices, eq(holidaySkipNotices.userId, userId)),
    ).toBe(0);

    // The sweep agrees — a weekend is not a missed work day, so neither the
    // notice row nor the message exists.
    const sent: string[] = [];
    await sweepMissedRuns({
      ...defaultSweepDeps,
      now: () => SWEEP_AT,
      dispatchMissed: async (_uid: string, html: string) => {
        sent.push(html);
        return "sent" as const;
      },
    });
    expect(sent).toHaveLength(0);
    expect(
      await db.$count(missedRunNotices, eq(missedRunNotices.userId, userId)),
    ).toBe(0);
  });
});
