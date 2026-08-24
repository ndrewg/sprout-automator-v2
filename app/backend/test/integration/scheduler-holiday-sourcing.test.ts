import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client";
import { runs } from "../../src/db/schema";
import { fireCron } from "../../src/services/scheduler";
import {
  closeTestServer,
  createUser,
  resetDatabase,
  setupDatabase,
  startTestServer,
} from "./harness";

// 13A/13B — fireCron must consult ALL THREE sources (library + EXTRA_HOLIDAYS
// overrides + gazette cache) when deciding whether to skip. This proves the
// scheduler wiring, not just the orchestrator in isolation.

const OVERRIDE_DATE = new Date("2026-11-20T04:00:00Z"); // noon Manila

describe("fireCron consults all three holiday sources", () => {
  beforeAll(async () => {
    await setupDatabase();
    await startTestServer();
  });
  beforeEach(async () => {
    await resetDatabase();
  });
  afterEach(() => {
    delete process.env["EXTRA_HOLIDAYS"];
  });
  afterAll(async () => {
    delete process.env["EXTRA_HOLIDAYS"];
    await closeTestServer();
  });

  it("skips (inserts no run) when EXTRA_HOLIDAYS overrides the day", async () => {
    process.env["EXTRA_HOLIDAYS"] = "2026-11-20=Special Day";
    const { user } = await createUser();

    await fireCron(user.id, "in", OVERRIDE_DATE);

    // A skip returns before any runs insert.
    const rows = await db.select().from(runs).where(eq(runs.userId, user.id));
    expect(rows).toHaveLength(0);
  });

  it("skips (inserts no run) on a library holiday", async () => {
    const { user } = await createUser();

    await fireCron(user.id, "in", new Date("2026-12-25T04:00:00Z")); // Christmas

    const rows = await db.select().from(runs).where(eq(runs.userId, user.id));
    expect(rows).toHaveLength(0);
  });
});
