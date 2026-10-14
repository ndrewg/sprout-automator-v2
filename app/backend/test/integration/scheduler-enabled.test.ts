import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { db } from "../../src/db/client";
import { schedules } from "../../src/db/schema";
import { startScheduling } from "../../src/services/scheduler";
import { tickHandlerNames } from "../../src/lib/wall-clock-tick";
import {
  closeTestServer,
  createUser,
  request,
  resetDatabase,
  setupDatabase,
  startTestServer,
} from "./harness";

// Phase 15D — one host schedules. `startScheduling()` is the boot gate: with
// SCHEDULER_ENABLED unset or false this process registers NOTHING time-based
// (no slots, no retry trigger, no sweep, no nightly jobs) and says so in one log
// line; with it true, the enabled schedules are rehydrated and the tick is armed.
//
// /health reports `scheduler.enabled` so an operator can see which host they are
// looking at. The flag is read lazily (config.schedulerEnabled()), which is why
// this file can exercise both states in one process.
//
// The vitest integration env sets SCHEDULER_ENABLED=true (this process stands in
// for the scheduling host), so the "unset/false" cases below are explicit.
const savedEnv = process.env["SCHEDULER_ENABLED"];

describe("the scheduler gate", () => {
  beforeAll(async () => {
    await setupDatabase();
    await startTestServer();
  });
  beforeEach(async () => {
    await resetDatabase();
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env["SCHEDULER_ENABLED"];
    else process.env["SCHEDULER_ENABLED"] = savedEnv;
  });
  afterAll(async () => {
    await closeTestServer();
  });

  it("with the key false, registers no tick handlers and loads no schedules", async () => {
    const { user } = await createUser();
    await db.insert(schedules).values({
      userId: user.id,
      clockInTime: "05:30:00",
      clockOutTime: "18:05:00",
      enabled: true,
    });

    process.env["SCHEDULER_ENABLED"] = "false";
    expect(await startScheduling()).toBe(false);
    expect(tickHandlerNames()).toEqual([]);
  });

  it("with the key true, rehydrates the schedules and arms the tick", async () => {
    const { user } = await createUser();
    await db.insert(schedules).values({
      userId: user.id,
      clockInTime: "05:30:00",
      clockOutTime: "18:05:00",
      enabled: true,
    });

    process.env["SCHEDULER_ENABLED"] = "true";
    expect(await startScheduling()).toBe(true);
    expect(tickHandlerNames()).toEqual(
      expect.arrayContaining(["scheduler", "retries"]),
    );

    // The schedule is registered, so /health's registered-vs-enabled check is
    // satisfied on this host.
    const res = await request("/health");
    const body = res.body as {
      scheduler: { enabled: boolean; registered: number; enabledInDb: number };
    };
    expect(body.scheduler.enabled).toBe(true);
    expect(body.scheduler.registered).toBe(1);
    expect(body.scheduler.enabledInDb).toBe(1);
    expect(res.status).toBe(200);
  });

  it("/health reports enabled:false and stays healthy on a deliberately off host", async () => {
    const { user } = await createUser();
    // Enabled schedules exist in the database, but this host is not the one that
    // runs them. That is a valid deployment, not a fault: it must not answer 503
    // or an uptime monitor would page someone about it.
    await db.insert(schedules).values({
      userId: user.id,
      clockInTime: "05:30:00",
      clockOutTime: "18:05:00",
      enabled: true,
    });

    process.env["SCHEDULER_ENABLED"] = "false";
    const res = await request("/health");
    const body = res.body as {
      status: string;
      scheduler: { enabled: boolean; registered: number; enabledInDb: number };
    };
    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.scheduler.enabled).toBe(false);
    expect(body.scheduler.registered).toBe(0);
  });
});
