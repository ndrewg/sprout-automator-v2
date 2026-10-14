import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client";
import { holidaySkipNotices, notificationSettings } from "../../src/db/schema";
import { encrypt } from "../../src/lib/encryption";
import {
  notifySkip,
  type DispatchOutcome,
} from "../../src/services/notifications";
import type { TelegramSendResult } from "../../src/lib/telegram";
import type { DayDecision, WorkdayReason } from "../../src/services/workday";
import {
  closeTestServer,
  createUser,
  resetDatabase,
  setupDatabase,
  startTestServer,
} from "./harness";

// The "skipping today" notification (phase 11B, widened in phase 16D). Proves
// against the real database (sprout_test) that:
//   - a skip fires exactly one Telegram message, naming the reason,
//   - a plain `public` library holiday is NO LONGER silent (phase 16D: every
//     skip notifies, so a wrong library date is visible),
//   - the idempotency ledger (holiday_skip_notices keyed on user+date) stops a
//     second dispatch — e.g. the `out` cron fire or a container restart,
//   - a weekend never notifies,
//   - a dead Telegram endpoint neither throws nor changes the skip decision
//     (hard rule 11).

const FAKE_TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"; // gitleaks:allow
const FAKE_CHAT_ID = "123456789";
// Noon in Manila on the target day, so the decision's Manila date is stable.
const NINO_DAY = "2026-08-21";

type SendFn = (
  botToken: string,
  chatId: string,
  html: string,
) => Promise<TelegramSendResult>;

function decision(reason: WorkdayReason, manilaDate = NINO_DAY): DayDecision {
  return { manilaDate, work: false, reason, override: null };
}

const HOLIDAY = (type: string, name: string): WorkdayReason => ({
  code: "holiday",
  label: `${name} (${type === "optional" ? "special non-working" : "regular holiday"})`,
  holidayName: name,
  holidayType: type,
  holidaySource: "library",
});

describe("skip notification (11B / 16D)", () => {
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

  it("fires one Telegram naming the reason, and is idempotent for the same day", async () => {
    const { user } = await createUser();
    await setupNotifications(user.id);
    const calls: string[] = [];

    const first = await notifySkip({
      userId: user.id,
      decision: decision(HOLIDAY("optional", "Ninoy Aquino Day")),
      now: new Date("2026-08-21T04:00:00Z"),
      send: makeSend(calls),
    });
    expect(first).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("Skipping today");
    expect(calls[0]).toContain("Ninoy Aquino Day");
    expect(calls[0]).toContain("special non-working");

    // The `out` fire (or a restart) fires again for the same user + Manila day.
    const second = await notifySkip({
      userId: user.id,
      decision: decision(HOLIDAY("optional", "Ninoy Aquino Day")),
      now: new Date("2026-08-21T04:00:00Z"),
      send: makeSend(calls),
    });
    expect(second).toBe("skipped");
    expect(calls).toHaveLength(1);

    // Exactly one ledger row was written.
    const rows = await db
      .select()
      .from(holidaySkipNotices)
      .where(eq(holidaySkipNotices.userId, user.id));
    expect(rows).toHaveLength(1);
  });

  it("a plain public library holiday now NOTIFIES (no silent skips)", async () => {
    const { user } = await createUser();
    await setupNotifications(user.id);
    const calls: string[] = [];

    const out = await notifySkip({
      userId: user.id,
      decision: decision(HOLIDAY("public", "Christmas Day"), "2026-12-25"),
      now: new Date("2026-12-25T04:00:00Z"),
      send: makeSend(calls),
    });
    expect(out).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("Christmas Day");
  });

  it("names the user's own skip day", async () => {
    const { user } = await createUser();
    await setupNotifications(user.id);
    const calls: string[] = [];

    const out = await notifySkip({
      userId: user.id,
      decision: decision({ code: "skip_day", label: "your skip day", note: null }),
      now: new Date("2026-08-21T04:00:00Z"),
      send: makeSend(calls),
    });
    expect(out).toBe("sent");
    expect(calls[0]).toContain("your skip day");
  });

  it("never notifies for a weekend", async () => {
    const { user } = await createUser();
    await setupNotifications(user.id);
    const calls: string[] = [];

    const out = await notifySkip({
      userId: user.id,
      decision: {
        manilaDate: "2026-08-22",
        work: false,
        reason: { code: "weekend", label: "weekend" },
        override: null,
      },
      now: new Date("2026-08-22T04:00:00Z"),
      send: makeSend(calls),
    });
    expect(out).toBe("skipped");
    expect(calls).toHaveLength(0);
    expect(
      await db.$count(holidaySkipNotices, eq(holidaySkipNotices.userId, user.id)),
    ).toBe(0);
  });

  it("a dead Telegram endpoint does not throw and does not affect the skip", async () => {
    process.env["TELEGRAM_API_BASE"] = "http://127.0.0.1:9"; // nothing listens here
    const { user } = await createUser();
    await setupNotifications(user.id);

    // No injected send — the real (dead) transport runs, but must not throw or
    // hold the caller. notifySkip resolves either way.
    let outcome: DispatchOutcome | undefined;
    await expect(
      (async () => {
        outcome = await notifySkip({
          userId: user.id,
          decision: decision(HOLIDAY("optional", "Ninoy Aquino Day")),
          now: new Date("2026-08-21T04:00:00Z"),
        });
      })(),
    ).resolves.toBeUndefined();
    expect(["sent", "skipped"]).toContain(outcome);
  });
});
