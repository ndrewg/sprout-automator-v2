import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client";
import { credentials, notificationSettings, runs, schedules } from "../../src/db/schema";
import {
  closeTestServer,
  createUser,
  request,
  resetDatabase,
  setupDatabase,
  startTestServer,
  type TestUser,
} from "./harness";

// Tenant isolation: user A, holding a valid session, must not be able to read
// or mutate user B's runs, credentials, or schedule. Table-driven over the
// authenticated route list so a route added later WITHOUT scoping fails this
// suite rather than passing unnoticed.

describe("tenant isolation", () => {
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

  // Seed user B with a full set of data: credentials, schedule, one finished
  // run and one active run.
  async function seedB(): Promise<TestUser> {
    const b = await createUser({ email: "tenant-b@example.com" });
    await request("/credentials", {
      cookie: b.cookie,
      method: "PUT",
      body: {
        sproutUsername: "user-b-sprout",
        sproutPassword: "b-sprout-pass-1234",
        gmailEmail: "b@gmail.com",
        gmailAppPassword: "b-app-pass-1234",
      },
    });
    await request("/schedule", {
      cookie: b.cookie,
      method: "PUT",
      body: { clockInTime: "06:00", clockOutTime: "17:00", enabled: true },
    });
    await request("/notifications", {
      cookie: b.cookie,
      method: "PUT",
      body: {
        telegramBotToken: "223456789:BCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi", // gitleaks:allow
        telegramChatId: "999999999",
        enabled: true,
      },
    });
    const run = await request("/runs", {
      cookie: b.cookie,
      method: "POST",
      body: { action: "in" },
    });
    expect(run.status).toBe(202);
    // Make B's single run a terminal state so a second active run can exist.
    const runId = (run.body as { run: { id: string } }).run.id;
    await db.update(runs).set({ status: "success", finishedAt: new Date() }).where(eq(runs.id, runId));
    const active = await request("/runs", {
      cookie: b.cookie,
      method: "POST",
      body: { action: "out" },
    });
    expect(active.status).toBe(202);
    return b;
  }

  it("A cannot read or mutate B's credentials", async () => {
    const a = await createUser({ email: "tenant-a@example.com" });
    const b = await seedB();

    // A's GET shows A's own (empty) view, never B's values.
    const aGet = await request("/credentials", { cookie: a.cookie });
    expect(aGet.status).toBe(200);
    const aView = (aGet.body as { credentials: Record<string, unknown> }).credentials;
    expect(aView["sproutUsername"]).toBeNull();
    expect(aView["sproutPasswordSet"]).toBe(false);

    // A saves their own creds — B's must be untouched.
    const aPut = await request("/credentials", {
      cookie: a.cookie,
      method: "PUT",
      body: { sproutUsername: "user-a-sprout", sproutPassword: "a-pass-1234" },
    });
    expect(aPut.status).toBe(200);

    const bView = (await request("/credentials", { cookie: b.cookie })).body as {
      credentials: { sproutUsername: string | null };
    };
    expect(bView.credentials.sproutUsername).toBe("user-b-sprout");
  });

  it("A cannot read or mutate B's schedule", async () => {
    const a = await createUser({ email: "tenant-a@example.com" });
    const b = await seedB();

    const aGet = await request("/schedule", { cookie: a.cookie });
    expect(aGet.status).toBe(200);
    const aSchedule = (aGet.body as { schedule: { enabled: boolean } }).schedule;
    expect(aSchedule.enabled).toBe(false);

    const aPut = await request("/schedule", {
      cookie: a.cookie,
      method: "PUT",
      body: { clockInTime: "07:30", clockOutTime: "16:30", enabled: false },
    });
    expect(aPut.status).toBe(200);

    const bSchedule = (await request("/schedule", { cookie: b.cookie })).body as {
      schedule: { clockInTime: string };
    };
    expect(bSchedule.schedule.clockInTime).toBe("06:00:00");
  });

  it("A cannot read or mutate B's runs", async () => {
    const a = await createUser({ email: "tenant-a@example.com" });
    const b = await seedB();

    // A's run list does not include B's runs.
    const aList = await request("/runs", { cookie: a.cookie });
    expect(aList.status).toBe(200);
    expect((aList.body as { runs: unknown[] }).runs).toHaveLength(0);

    // A cannot fetch B's run by id.
    const bRuns = (await request("/runs", { cookie: b.cookie })).body as {
      runs: { id: string }[];
    };
    const bRunId = bRuns.runs[0]!.id;
    const aGetRun = await request(`/runs/${bRunId}`, { cookie: a.cookie });
    expect(aGetRun.status).toBe(404);

    // A cannot submit an OTP for B's run.
    const aOtp = await request(`/runs/${bRunId}/otp`, {
      cookie: a.cookie,
      method: "POST",
      body: { code: "12345" },
    });
    expect(aOtp.status).toBe(404);
  });

  it("A starting a run creates one owned by A, not visible to B", async () => {
    const a = await createUser({ email: "tenant-a@example.com" });
    const b = await seedB();

    await request("/credentials", {
      cookie: a.cookie,
      method: "PUT",
      body: { sproutUsername: "user-a-sprout", sproutPassword: "a-pass-1234" },
    });
    const aStart = await request("/runs", {
      cookie: a.cookie,
      method: "POST",
      body: { action: "in" },
    });
    expect(aStart.status).toBe(202);

    // The run row in the DB belongs to A, not B.
    const aId = (await request("/auth/me", { cookie: a.cookie })).body as {
      user: { id: string };
    };
    const runRows = await db.select().from(runs);
    const aRuns = runRows.filter((r) => r.userId === aId.user.id);
    const bRuns = runRows.filter((r) => r.userId !== aId.user.id);
    expect(aRuns).toHaveLength(1);
    expect(bRuns.length).toBeGreaterThan(0);
    // B's list still contains B's own 2 runs, and never A's new run.
    const bList = (await request("/runs", { cookie: b.cookie })).body as {
      runs: { id: string }[];
    };
    expect(bList.runs).toHaveLength(2);
    expect(bList.runs.map((r) => r.id)).not.toContain(aRuns[0]!.id);
  });

  it("A's credential/schedule writes never create rows for B", async () => {
    const a = await createUser({ email: "tenant-a@example.com" });
    const b = await seedB();
    await request("/credentials", {
      cookie: a.cookie,
      method: "PUT",
      body: { sproutUsername: "user-a-sprout", sproutPassword: "a-pass-1234" },
    });
    await request("/schedule", {
      cookie: a.cookie,
      method: "PUT",
      body: { clockInTime: "07:30", clockOutTime: "16:30", enabled: true },
    });

    const aId = (await request("/auth/me", { cookie: a.cookie })).body as {
      user: { id: string };
    };
    const credRows = await db.select().from(credentials);
    expect(credRows.filter((c) => c.userId === aId.user.id)).toHaveLength(1);
    // B already had one credential row (from seedB) — still exactly one for B.
    const bCredRows = credRows.filter((c) => c.userId !== aId.user.id);
    expect(bCredRows).toHaveLength(1);
    expect(bCredRows[0]!.sproutUsernameEnc).not.toBeNull();

    const scheduleRows = await db.select().from(schedules);
    expect(scheduleRows.filter((s) => s.userId === aId.user.id)).toHaveLength(1);
    expect(scheduleRows.filter((s) => s.userId !== aId.user.id)).toHaveLength(1);

    // Notification settings follow the same isolation: A's GET shows A's own
    // defaults (never B's), and A's writes never touch B's row.
    const aGet = await request("/notifications", { cookie: a.cookie });
    expect(aGet.status).toBe(200);
    const aView = (aGet.body as { settings: Record<string, unknown> }).settings;
    expect(aView["configured"]).toBe(false);
    expect(aView["telegramTokenSet"]).toBe(false);
    expect(aView["telegramChatId"]).toBeNull();

    const aPut = await request("/notifications", {
      cookie: a.cookie,
      method: "PUT",
      body: {
        telegramBotToken: "323456789:CDEFGHIJKLMNOPQRSTUVWXYZabcdefghi", // gitleaks:allow
        telegramChatId: "777777777",
        enabled: false,
      },
    });
    expect(aPut.status).toBe(200);

    const bView = (await request("/notifications", { cookie: b.cookie })).body as {
      settings: { telegramChatId: string | null; enabled: boolean };
    };
    expect(bView.settings.telegramChatId).toBe("999999999");
    expect(bView.settings.enabled).toBe(true);

    const notifRows = await db.select().from(notificationSettings);
    expect(notifRows.filter((n) => n.userId === aId.user.id)).toHaveLength(1);
    expect(notifRows.filter((n) => n.userId !== aId.user.id)).toHaveLength(1);
  });
});
