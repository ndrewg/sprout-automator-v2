import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client";
import { credentials, dayOverrides, runs } from "../../src/db/schema";
import { encrypt } from "../../src/lib/encryption";
import { fireCron } from "../../src/services/scheduler";
import {
  closeTestServer,
  createUser,
  resetDatabase,
  setupDatabase,
  startTestServer,
} from "./harness";

// Phase 16A: fireCron asks the Workday gate, which consults the library, the
// company EXTRA_HOLIDAYS and the user's own day override. This proves the
// SCHEDULER wiring, not just the gate in isolation.

const NINO_DATE = new Date("2026-08-21T04:00:00Z"); // Friday, noon Manila
const OVERRIDE_DATE = new Date("2026-11-20T04:00:00Z"); // Friday, noon Manila

describe("fireCron consults the Workday gate", () => {
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

  async function userWithCredentials(): Promise<{ userId: string }> {
    const { user } = await createUser();
    await db.insert(credentials).values({
      userId: user.id,
      sproutUsernameEnc: encrypt("sprout-user"),
      sproutPasswordEnc: encrypt("sprout-password"),
    });
    return { userId: user.id };
  }

  it("skips (inserts no run) when EXTRA_HOLIDAYS overrides the day", async () => {
    process.env["EXTRA_HOLIDAYS"] = "2026-11-20=Special Day";
    const { user } = await createUser();

    await fireCron(user.id, "in", OVERRIDE_DATE);

    const rows = await db.select().from(runs).where(eq(runs.userId, user.id));
    expect(rows).toHaveLength(0);
  });

  it("skips (inserts no run) on a library holiday", async () => {
    const { user } = await createUser();

    await fireCron(user.id, "in", new Date("2026-12-25T04:00:00Z")); // Christmas

    const rows = await db.select().from(runs).where(eq(runs.userId, user.id));
    expect(rows).toHaveLength(0);
  });

  it("skips (inserts no run) on the user's own skip day", async () => {
    const { userId } = await userWithCredentials();
    await db.insert(dayOverrides).values({
      userId,
      manilaDate: "2026-11-20",
      kind: "skip",
      note: "leave",
    });

    const result = await fireCron(userId, "in", OVERRIDE_DATE);

    expect(result.outcome).toBe("skipped");
    const rows = await db.select().from(runs).where(eq(runs.userId, userId));
    expect(rows).toHaveLength(0);
  });

  it("RUNS on a library holiday the user marked as a workday", async () => {
    const { userId } = await userWithCredentials();
    await db.insert(dayOverrides).values({
      userId,
      manilaDate: "2026-08-21",
      kind: "work",
      note: "covering for a colleague",
    });

    const result = await fireCron(userId, "in", NINO_DATE);

    expect(result.outcome).toBe("created");
    const rows = await db.select().from(runs).where(eq(runs.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("in");
  });
});
