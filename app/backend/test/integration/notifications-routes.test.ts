import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/db/client";
import { auditLog, notificationSettings } from "../../src/db/schema";
import { decryptOptional } from "../../src/lib/encryption";
import {
  closeTestServer,
  createUser,
  request,
  resetDatabase,
  setupDatabase,
  startTestServer,
} from "./harness";

// Gate 6F route behavior: token round-trip (set flag, never the value), the
// three-way partial update, the enable-guard, the per-user test rate limit,
// and "no token anywhere". Real Telegram is never contacted — the test route's
// transport is pointed at a dead port when the network path is exercised.

const FAKE_TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"; // gitleaks:allow
const FAKE_CHAT_ID = "123456789";

describe("notification settings routes", () => {
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

  it("PUT with a token → GET shows telegramTokenSet and the stored blob is opaque", async () => {
    const { user, cookie } = await createUser();
    const res = await request("/notifications", {
      cookie,
      method: "PUT",
      body: { telegramBotToken: FAKE_TOKEN, telegramChatId: FAKE_CHAT_ID },
    });
    expect(res.status).toBe(200);
    const view = (res.body as { settings: Record<string, unknown> }).settings;
    expect(view["telegramTokenSet"]).toBe(true);
    expect(view["telegramChatId"]).toBe(FAKE_CHAT_ID);
    expect(view["configured"]).toBe(true);
    expect(view["enabled"]).toBe(false); // never auto-enabled

    const get = await request("/notifications", { cookie });
    expect(JSON.stringify(get.body)).not.toContain(FAKE_TOKEN);

    const [row] = await db
      .select()
      .from(notificationSettings)
      .where(eq(notificationSettings.userId, user.id))
      .limit(1);
    expect(row?.telegramBotTokenEnc).not.toBeNull();
    expect(row?.telegramBotTokenEnc).not.toContain(FAKE_TOKEN);
    expect(row?.telegramBotTokenEnc).toMatch(/^[A-Za-z0-9_-]+$/); // base64url
    expect(decryptOptional(row?.telegramBotTokenEnc)).toBe(FAKE_TOKEN);
  });

  it("saving without touching the token field leaves the stored token intact", async () => {
    const { user, cookie } = await createUser();
    await request("/notifications", {
      cookie,
      method: "PUT",
      body: { telegramBotToken: FAKE_TOKEN, telegramChatId: FAKE_CHAT_ID },
    });
    // Update ONLY a toggle — the token must survive untouched.
    const res = await request("/notifications", {
      cookie,
      method: "PUT",
      body: { notifyOnSkipped: false },
    });
    expect(res.status).toBe(200);

    const get = await request("/notifications", { cookie });
    const view = (get.body as { settings: Record<string, unknown> }).settings;
    expect(view["telegramTokenSet"]).toBe(true);
    expect(view["notifyOnSkipped"]).toBe(false);

    const [row] = await db
      .select()
      .from(notificationSettings)
      .where(eq(notificationSettings.userId, user.id))
      .limit(1);
    expect(decryptOptional(row?.telegramBotTokenEnc)).toBe(FAKE_TOKEN);
  });

  it("null clears a field; omitting a field leaves it unchanged", async () => {
    const { cookie } = await createUser();
    await request("/notifications", {
      cookie,
      method: "PUT",
      body: { telegramBotToken: FAKE_TOKEN, telegramChatId: FAKE_CHAT_ID },
    });
    const cleared = await request("/notifications", {
      cookie,
      method: "PUT",
      body: { telegramChatId: null },
    });
    expect(cleared.status).toBe(200);
    const view = (cleared.body as { settings: Record<string, unknown> }).settings;
    expect(view["telegramChatId"]).toBeNull();
    expect(view["telegramTokenSet"]).toBe(true); // untouched by the chatId clear
  });

  it("enabled:true is rejected with 400 without a token and chat ID", async () => {
    const { cookie } = await createUser();
    const noToken = await request("/notifications", {
      cookie,
      method: "PUT",
      body: { enabled: true },
    });
    expect(noToken.status).toBe(400);

    const noChat = await request("/notifications", {
      cookie,
      method: "PUT",
      body: { telegramBotToken: FAKE_TOKEN, enabled: true },
    });
    expect(noChat.status).toBe(400);
  });

  it("enabled:true is accepted once token and chat ID exist", async () => {
    const { cookie } = await createUser();
    const setup = await request("/notifications", {
      cookie,
      method: "PUT",
      body: { telegramBotToken: FAKE_TOKEN, telegramChatId: FAKE_CHAT_ID },
    });
    expect(setup.status).toBe(200);
    const enable = await request("/notifications", {
      cookie,
      method: "PUT",
      body: { enabled: true },
    });
    expect(enable.status).toBe(200);
    expect(
      (enable.body as { settings: { enabled: boolean } }).settings.enabled,
    ).toBe(true);
  });

  it("empty body → 400 No fields to update", async () => {
    const { cookie } = await createUser();
    const res = await request("/notifications", {
      cookie,
      method: "PUT",
      body: {},
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "No fields to update" });
  });

  it("GET /notifications for a fresh user reports configured:false defaults", async () => {
    const { cookie } = await createUser();
    const res = await request("/notifications", { cookie });
    expect(res.status).toBe(200);
    const view = (res.body as { settings: Record<string, unknown> }).settings;
    expect(view["configured"]).toBe(false);
    expect(view["enabled"]).toBe(false);
    expect(view["telegramTokenSet"]).toBe(false);
    expect(view["notifyOnMissed"]).toBe(true);
  });

  it("two test requests within 10s: the second is 429 (per-user, not per-IP)", async () => {
    process.env["TELEGRAM_API_BASE"] = "http://127.0.0.1:9";
    const { cookie } = await createUser();
    await request("/notifications", {
      cookie,
      method: "PUT",
      body: { telegramBotToken: FAKE_TOKEN, telegramChatId: FAKE_CHAT_ID },
    });

    const first = await request("/notifications/test", { cookie, method: "POST" });
    // getBotInfo hits the dead endpoint → network error → specific 400, and no
    // raw Telegram error is echoed.
    expect(first.status).toBe(400);
    expect(JSON.stringify(first.body)).not.toContain("fetch failed");
    expect(JSON.stringify(first.body)).not.toContain(FAKE_TOKEN);

    const second = await request("/notifications/test", { cookie, method: "POST" });
    expect(second.status).toBe(429);
  });

  it("the audit row for settings updates never contains the token or chat id value", async () => {
    const { user, cookie } = await createUser();
    await request("/notifications", {
      cookie,
      method: "PUT",
      body: { telegramBotToken: FAKE_TOKEN, telegramChatId: FAKE_CHAT_ID },
    });

    const [row] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.userId, user.id),
          eq(auditLog.eventType, "notification_settings_updated"),
        ),
      )
      .limit(1);
    expect(row?.eventType).toBe("notification_settings_updated");
    const metadata = JSON.stringify(row?.metadata ?? {});
    expect(metadata).not.toContain(FAKE_TOKEN);
    expect(metadata).not.toContain(FAKE_CHAT_ID);
    // …but it does say the token became set.
    expect(metadata).toContain('"telegramTokenSet":true');
  });
});
