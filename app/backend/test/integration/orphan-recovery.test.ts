import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { runs } from "../../src/db/schema";
import { db } from "../../src/db/client";
import { recoverOrphanedRuns } from "../../src/services/run-queue";
import {
  closeTestServer,
  createUser,
  request,
  resetDatabase,
  setupDatabase,
  startTestServer,
} from "./harness";

// Orphan recovery: a run left pending/running by a previous crash must be
// flipped to failure with the restart message, unblocking the user's
// single-active-run guard. This is what lets a user start a new run after a
// crash.
describe("orphan recovery", () => {
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

  it("flips a running orphan to failure with the restart message", async () => {
    const { user, cookie } = await createUser();
    await request("/credentials", {
      cookie,
      method: "PUT",
      body: { sproutUsername: "orphan-user", sproutPassword: "orphan-pass-1234" },
    });

    // Simulate a crash: insert a run that a previous shutdown left running.
    const [orphan] = await db
      .insert(runs)
      .values({ userId: user.id, action: "in", status: "running" })
      .returning();
    if (!orphan) throw new Error("orphan insert returned no row");

    const recovered = await recoverOrphanedRuns();
    expect(recovered).toBe(1);

    const [row] = await db.select().from(runs).where(eq(runs.id, orphan.id));
    expect(row?.status).toBe("failure");
    expect(row?.error).toBe("Interrupted by server restart");
    expect(row?.finishedAt).not.toBeNull();
  });

  it("recovers pending orphans too, not just running ones", async () => {
    // Two users, so both inserts of pending runs satisfy the single-active-run
    // partial unique index (one pending per user).
    const { user: u1 } = await createUser();
    const { user: u2 } = await createUser();
    await db.insert(runs).values({ userId: u1.id, action: "in", status: "pending" });
    await db.insert(runs).values({ userId: u2.id, action: "out", status: "pending" });

    const recovered = await recoverOrphanedRuns();
    expect(recovered).toBe(2);
  });

  it("after recovery the user can start a new run", async () => {
    const { user, cookie } = await createUser();
    await request("/credentials", {
      cookie,
      method: "PUT",
      body: { sproutUsername: "orphan-user", sproutPassword: "orphan-pass-1234" },
    });
    await db
      .insert(runs)
      .values({ userId: user.id, action: "in", status: "running" })
      .returning();

    await recoverOrphanedRuns();

    const start = await request("/runs", {
      cookie,
      method: "POST",
      body: { action: "in" },
    });
    expect(start.status).toBe(202);
  });
});
