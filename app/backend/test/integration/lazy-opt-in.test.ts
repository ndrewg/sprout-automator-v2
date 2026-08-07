import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeTestServer,
  createUser,
  request,
  resetDatabase,
  setupDatabase,
  startTestServer,
} from "./harness";

// Lazy opt-in: the schedules.enabled column defaults to true in the DB, so the
// schedule route MUST override it to false on a fresh insert unless the caller
// explicitly sent enabled: true. Otherwise every user who just saves times gets
// auto-enabled. This test pins that route-level behavior.
describe("lazy opt-in (schedule.enabled)", () => {
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

  it("a fresh schedule created without enabled stays disabled", async () => {
    const { cookie } = await createUser();
    const res = await request("/schedule", {
      cookie,
      method: "PUT",
      body: { clockInTime: "05:30", clockOutTime: "18:05" },
    });
    expect(res.status).toBe(200);
    const schedule = (res.body as { schedule: { enabled: boolean } }).schedule;
    expect(schedule.enabled).toBe(false);

    // And it stays disabled on a subsequent read (the row was persisted).
    const getRes = await request("/schedule", { cookie });
    expect((getRes.body as { schedule: { enabled: boolean } }).schedule.enabled).toBe(false);
  });

  it("enabled: true is still honored when explicitly sent", async () => {
    const { cookie } = await createUser();
    const res = await request("/schedule", {
      cookie,
      method: "PUT",
      body: { clockInTime: "05:30", clockOutTime: "18:05", enabled: true },
    });
    expect(res.status).toBe(200);
    const schedule = (res.body as { schedule: { enabled: boolean } }).schedule;
    expect(schedule.enabled).toBe(true);
  });

  it("an existing disabled schedule is not enabled by a times-only update", async () => {
    const { cookie } = await createUser();
    await request("/schedule", {
      cookie,
      method: "PUT",
      body: { clockInTime: "05:30", clockOutTime: "18:05" },
    });
    // Update ONLY the times; enabled must survive as false (not reset to the
    // DB default, not flipped on).
    const res = await request("/schedule", {
      cookie,
      method: "PUT",
      body: { clockInTime: "06:00", clockOutTime: "19:00" },
    });
    expect(res.status).toBe(200);
    expect((res.body as { schedule: { enabled: boolean } }).schedule.enabled).toBe(false);
  });

  it("GET /schedule for a fresh user reports configured:false and enabled:false", async () => {
    const { cookie } = await createUser();
    const res = await request("/schedule", { cookie });
    expect(res.status).toBe(200);
    const schedule = (res.body as { schedule: { configured: boolean; enabled: boolean } }).schedule;
    expect(schedule.configured).toBe(false);
    expect(schedule.enabled).toBe(false);
  });
});
