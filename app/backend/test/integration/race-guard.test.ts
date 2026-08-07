import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { runs } from "../../src/db/schema";
import { db } from "../../src/db/client";
import {
  closeTestServer,
  createUser,
  request,
  resetDatabase,
  setupDatabase,
  startTestServer,
} from "./harness";

// The single-active-run race guard: the partial unique index on
// runs_one_active_per_user is the mechanism, so this must be a REAL database —
// a mocked DB proves nothing. The 1×202 / N−1×409 split is decided in
// startRun (insert as pending, catch 23505), regardless of what the automation
// would then do. The executor is deliberately NOT registered in tests (T1), so
// the winning run stays pending until we finish it directly.

const CONCURRENCY = 8;

describe("single-active-run race guard", () => {
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

  async function userWithSproutCreds(): Promise<{ cookie: string }> {
    const { cookie } = await createUser();
    await request("/credentials", {
      cookie,
      method: "PUT",
      body: { sproutUsername: "race-guard-user", sproutPassword: "sprout-pass-1234" },
    });
    return { cookie };
  }

  async function activeRunCount(): Promise<number> {
    return db.$count(runs, eq(runs.status, "pending"));
  }

  it("allows exactly one of N concurrent starts; the rest get 409", async () => {
    const { cookie } = await userWithSproutCreds();

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        request("/runs", { cookie, method: "POST", body: { action: "in" } }),
      ),
    );

    const accepted = results.filter((r) => r.status === 202);
    const rejected = results.filter((r) => r.status === 409);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(CONCURRENCY - 1);
    for (const r of rejected) {
      expect(r.body).toMatchObject({ error: "A run is already in progress" });
    }

    // Exactly one pending row survives in the DB — the index, not a SELECT, decided.
    expect(await activeRunCount()).toBe(1);
  });

  it("accepts a new run once the active one is finished", async () => {
    const { cookie } = await userWithSproutCreds();
    const first = await request("/runs", {
      cookie,
      method: "POST",
      body: { action: "in" },
    });
    expect(first.status).toBe(202);

    // While active, a second start is rejected.
    const second = await request("/runs", {
      cookie,
      method: "POST",
      body: { action: "out" },
    });
    expect(second.status).toBe(409);

    // Finish the winning run (terminal status) — the guard must release.
    const run = (first.body as { run: { id: string } }).run;
    await db
      .update(runs)
      .set({ status: "success", finishedAt: new Date() })
      .where(eq(runs.id, run.id));

    const third = await request("/runs", {
      cookie,
      method: "POST",
      body: { action: "out" },
    });
    expect(third.status).toBe(202);
  });
});
