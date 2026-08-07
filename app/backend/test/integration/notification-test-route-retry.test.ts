import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client";
import { notificationSettings } from "../../src/db/schema";
import { encrypt } from "../../src/lib/encryption";
import {
  closeTestServer,
  createUser,
  request,
  resetDatabase,
  setupDatabase,
  startTestServer,
} from "./harness";

// Review defect 19: the interactive Test-connection button must fail fast. The
// route caps its transport calls at {maxAttempts: 2} (background dispatch keeps
// the default 3), so a genuine failure costs ~30s instead of ~90s. The transport
// is mocked here — the property under test is the retry config the ROUTE passes,
// not the network.

const TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"; // gitleaks:allow
const CHAT_ID = "123456789";

vi.mock("../../src/lib/telegram", async (importActual) => {
  const actual =
    await importActual<typeof import("../../src/lib/telegram")>();
  return {
    ...actual,
    getBotInfo: vi.fn(),
    sendTelegramMessage: vi.fn(),
  };
});

import { getBotInfo, sendTelegramMessage } from "../../src/lib/telegram";

const getBotInfoMock = vi.mocked(getBotInfo);
const sendTelegramMessageMock = vi.mocked(sendTelegramMessage);

async function seedSettings(userId: string): Promise<void> {
  await db.insert(notificationSettings).values({
    userId,
    telegramBotTokenEnc: encrypt(TOKEN),
    telegramChatId: CHAT_ID,
    enabled: true,
  });
}

describe("the test route caps its retries at 2 while dispatch keeps 3", () => {
  beforeAll(async () => {
    await setupDatabase();
    await startTestServer();
  });
  beforeEach(async () => {
    await resetDatabase();
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await closeTestServer();
  });

  it("getBotInfo is called with { maxAttempts: 2 } and a failure fails fast", async () => {
    const { user, cookie } = await createUser();
    await seedSettings(user.id);
    getBotInfoMock.mockResolvedValue({ ok: false, error: "network" });

    const res = await request("/notifications/test", {
      cookie,
      method: "POST",
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: "Could not reach Telegram. Check the server's network connectivity.",
    });
    expect(getBotInfoMock).toHaveBeenCalledWith(TOKEN, { maxAttempts: 2 });
    // Failed at getMe — no send attempted.
    expect(sendTelegramMessageMock).not.toHaveBeenCalled();
  });

  it("sendTelegramMessage is also called with { maxAttempts: 2 }", async () => {
    const { user, cookie } = await createUser();
    await seedSettings(user.id);
    getBotInfoMock.mockResolvedValue({
      ok: true,
      username: "sprout_automator_bot",
      id: 1,
    });
    sendTelegramMessageMock.mockResolvedValue({ ok: false, error: "network" });

    const res = await request("/notifications/test", {
      cookie,
      method: "POST",
    });
    expect(res.status).toBe(400);
    expect(getBotInfoMock).toHaveBeenCalledWith(TOKEN, { maxAttempts: 2 });
    expect(sendTelegramMessageMock).toHaveBeenCalledWith(
      TOKEN,
      CHAT_ID,
      expect.stringContaining("Sprout Automator test"),
      { maxAttempts: 2 },
    );
  });
});
