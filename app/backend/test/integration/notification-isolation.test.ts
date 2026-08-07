import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client";
import { notificationSettings, runs } from "../../src/db/schema";
import { encrypt } from "../../src/lib/encryption";
import { executeQueuedRun } from "../../src/services/runs";
import {
  closeTestServer,
  createUser,
  request,
  resetDatabase,
  setupDatabase,
  startTestServer,
} from "./harness";

// The "notifications never affect runs" guarantee (D11 / hard rule 11), proven
// against a dead Telegram endpoint: the run must still reach its terminal state
// on time. The automation itself is mocked so no Chromium launches — the
// property under test is the run↔notification coupling, not the automation.
vi.mock("../../src/automation/runAutomation", () => ({
  runAutomation: vi
    .fn()
    .mockRejectedValue(new Error("boom: automation exploded")),
}));

describe("notifications never affect runs", () => {
  beforeAll(async () => {
    await setupDatabase();
    await startTestServer();
  });
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    delete process.env["TELEGRAM_API_BASE"];
    await closeTestServer();
  });

  it("a dead Telegram endpoint does not change a run reaching its terminal state", async () => {
    process.env["TELEGRAM_API_BASE"] = "http://127.0.0.1:9"; // nothing listens here

    const { user, cookie } = await createUser();
    await request("/credentials", {
      cookie,
      method: "PUT",
      body: { sproutUsername: "isolation-user", sproutPassword: "sprout-pass-1234" },
    });
    // Notifications configured and enabled — but pointed at a dead endpoint.
    await db.insert(notificationSettings).values({
      userId: user.id,
      telegramBotTokenEnc: encrypt(
        "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij", // gitleaks:allow
      ),
      telegramChatId: "123456789",
      enabled: true,
    });

    const start = await request("/runs", {
      cookie,
      method: "POST",
      body: { action: "in" },
    });
    expect(start.status).toBe(202);
    const runId = (start.body as { run: { id: string } }).run.id;

    await executeQueuedRun(runId);

    // The run reached its terminal state regardless of the notification path.
    const [finished] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);
    expect(finished?.status).toBe("failure");
    expect(finished?.error).toBe("boom: automation exploded");
    expect(finished?.finishedAt).not.toBeNull();

    // The failed send (network) must NOT have incremented the blocked count —
    // a blip is not the user blocking the bot.
    const [settings] = await db
      .select()
      .from(notificationSettings)
      .where(eq(notificationSettings.userId, user.id))
      .limit(1);
    expect(settings?.blockedCount).toBe(0);
    expect(settings?.enabled).toBe(true);
  });
});
