import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runs } from "../../src/db/schema";
import { db } from "../../src/db/client";
import {
  closeTestServer,
  createUser,
  request,
  resetDatabase,
  setupDatabase,
  startTestServer,
  type TestUser,
} from "./harness";

// Phase 9A: GET /runs accepts an optional limit (coerced int, 1–100, default
// 10) and reports hasMore via limit+1 selection. The old hardcoded .limit(20)
// made runs 21+ unreachable, dropped with nothing indicating more existed.
// Because the query changed, tenant isolation is re-asserted here at several
// limits.

describe("GET /runs pagination (phase 9A)", () => {
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

  // Seed terminal runs directly in the DB. This endpoint only reads, and going
  // through POST /runs would trip the single-active-run guard and enqueue the
  // real executor; direct inserts shape history without side effects.
  async function seedRuns(userId: string, count: number): Promise<void> {
    await db.insert(runs).values(
      Array.from({ length: count }, (_, i) => ({
        userId,
        action: i % 2 === 0 ? ("in" as const) : ("out" as const),
        status: "success" as const,
        startedAt: new Date(Date.now() - i * 60_000),
        finishedAt: new Date(Date.now() - i * 60_000 + 30_000),
      })),
    );
  }

  function runList(body: unknown): { id: string; startedAt: string }[] {
    return (body as { runs: { id: string; startedAt: string }[] }).runs;
  }

  function hasMoreOf(body: unknown): boolean {
    return (body as { hasMore: boolean }).hasMore;
  }

  it("returns at most 10 runs with no limit, newest first", async () => {
    const { cookie, user } = await createUser();
    await seedRuns(user.id, 15);

    const res = await request("/runs", { cookie });
    expect(res.status).toBe(200);
    expect(runList(res.body)).toHaveLength(10);
    expect(hasMoreOf(res.body)).toBe(true);

    const dates = runList(res.body).map((r) => new Date(r.startedAt).getTime());
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i - 1]!).toBeGreaterThan(dates[i]!);
    }
  });

  it("returns up to 25 rows with ?limit=25", async () => {
    const { cookie, user } = await createUser();
    await seedRuns(user.id, 30);

    const res = await request("/runs?limit=25", { cookie });
    expect(res.status).toBe(200);
    expect(runList(res.body)).toHaveLength(25);
    expect(hasMoreOf(res.body)).toBe(true);
  });

  it("400 for out-of-range or non-numeric limit — never a silent clamp", async () => {
    const { cookie } = await createUser();
    for (const limit of ["0", "101", "abc", "-3", "10.5"]) {
      const res = await request(`/runs?limit=${limit}`, { cookie });
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toBe("Invalid input");
    }
  });

  it("hasMore: true with 11 runs at limit=10, false with exactly 10", async () => {
    const { cookie, user } = await createUser();
    await seedRuns(user.id, 11);

    const res = await request("/runs?limit=10", { cookie });
    expect(res.status).toBe(200);
    expect(runList(res.body)).toHaveLength(10);
    expect(hasMoreOf(res.body)).toBe(true);

    // A second user with exactly 10 runs shows the boundary the other way.
    const { cookie: c2, user: u2 } = await createUser();
    await seedRuns(u2.id, 10);
    const res2 = await request("/runs?limit=10", { cookie: c2 });
    expect(res2.status).toBe(200);
    expect(runList(res2.body)).toHaveLength(10);
    expect(hasMoreOf(res2.body)).toBe(false);
  });

  it("another user's runs never appear at any limit", async () => {
    const b: TestUser = await createUser({ email: "runs-b@example.com" });
    await seedRuns(b.user.id, 20);
    const a: TestUser = await createUser({ email: "runs-a@example.com" });

    for (const limit of ["10", "25", "100"]) {
      const res = await request(`/runs?limit=${limit}`, { cookie: a.cookie });
      expect(res.status).toBe(200);
      expect(runList(res.body)).toHaveLength(0);
      expect(hasMoreOf(res.body)).toBe(false);
    }
  });
});
