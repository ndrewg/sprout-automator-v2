import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client";
import { holidaySkipNotices, notificationSettings } from "../../src/db/schema";
import { encrypt } from "../../src/lib/encryption";
import { notifyHolidaySkip, type DispatchOutcome } from "../../src/services/notifications";
import type { TelegramSendResult } from "../../src/lib/telegram";
import {
  closeTestServer,
  createUser,
  resetDatabase,
  setupDatabase,
  startTestServer,
} from "./harness";

// Phase 11B — the "special non-working day" reminder. Proves against the real
// database (sprout_test) that:
//   - an `optional` holiday skip fires exactly one Telegram reminder,
//   - a `public` holiday skip is silent (no insert, no send),
//   - the idempotency ledger (holiday_skip_notices keyed on user+date) stops a
//     second dispatch — e.g. the `out` cron fire or a container restart,
//   - a dead Telegram endpoint neither throws nor changes the skip decision
//     (hard rule 11 — notifications never affect runs, and here, the skip).

const FAKE_TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"; // gitleaks:allow
const FAKE_CHAT_ID = "123456789";
// Noon in Manila on the target day, so manilaDateString(now) is stable.
const NINO_DAY = new Date("2026-08-21T04:00:00Z");
const CHRISTMAS = new Date("2026-12-25T04:00:00Z");

type SendFn = (
  botToken: string,
  chatId: string,
  html: string,
) => Promise<TelegramSendResult>;

describe("holiday skip notification (11B)", () => {
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

  async function setupNotifications(userId: string): Promise<void> {
    await db.insert(notificationSettings).values({
      userId,
      telegramBotTokenEnc: encrypt(FAKE_TOKEN),
      telegramChatId: FAKE_CHAT_ID,
      enabled: true,
    });
  }

  function makeSend(calls: string[]): SendFn {
    return async (_botToken, _chatId, html) => {
      calls.push(html);
      return { ok: true } as TelegramSendResult;
    };
  }

  it("fires one Telegram for an optional holiday, and is silent for a public holiday", async () => {
    const { user } = await createUser();
    await setupNotifications(user.id);
    const calls: string[] = [];

    const optionalOutcome = await notifyHolidaySkip(
      user.id,
      { name: "Ninoy Aquino Day", type: "optional", source: "library" },
      NINO_DAY,
      makeSend(calls),
    );
    expect(optionalOutcome).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("Ninoy Aquino Day");
    expect(calls[0]).toContain("Clock in now");
    expect(calls[0]).toContain("special non-working day");

    // A public holiday on the same user — silent: no insert, no send.
    const publicOutcome = await notifyHolidaySkip(
      user.id,
      { name: "Christmas Day", type: "public", source: "library" },
      CHRISTMAS,
      makeSend(calls),
    );
    expect(publicOutcome).toBe("skipped");
    expect(calls).toHaveLength(1); // unchanged
  });

  it("is idempotent — a second dispatch for the same user+date is suppressed", async () => {
    const { user } = await createUser();
    await setupNotifications(user.id);
    const calls: string[] = [];

    const first = await notifyHolidaySkip(
      user.id,
      { name: "Ninoy Aquino Day", type: "optional", source: "library" },
      NINO_DAY,
      makeSend(calls),
    );
    expect(first).toBe("sent");

    // The `out` fire (or a restart) fires again for the same user + Manila day.
    const second = await notifyHolidaySkip(
      user.id,
      { name: "Ninoy Aquino Day", type: "optional", source: "library" },
      NINO_DAY,
      makeSend(calls),
    );
    expect(second).toBe("skipped");
    expect(calls).toHaveLength(1);

    // Exactly one ledger row was written.
    const rows = await db
      .select()
      .from(holidaySkipNotices)
      .where(eq(holidaySkipNotices.userId, user.id));
    expect(rows).toHaveLength(1);
  });

  it("a dead Telegram endpoint does not throw and does not affect the skip", async () => {
    process.env["TELEGRAM_API_BASE"] = "http://127.0.0.1:9"; // nothing listens here
    const { user } = await createUser();
    await setupNotifications(user.id);

    // No injected send — the real (dead) transport runs, but must not throw or
    // hold the caller. notifyHolidaySkip resolves either way.
    let outcome: DispatchOutcome | undefined;
    await expect(
      (async () => {
        outcome = await notifyHolidaySkip(
          user.id,
          { name: "Ninoy Aquino Day", type: "optional", source: "library" },
          NINO_DAY,
        );
      })(),
    ).resolves.toBeUndefined();
    expect(["sent", "skipped"]).toContain(outcome);
  });
});
