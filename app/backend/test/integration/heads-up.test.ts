import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client";
import {
  dayOverrides,
  headsUpNotices,
  notificationSettings,
  runs,
  schedules,
} from "../../src/db/schema";
import { encrypt } from "../../src/lib/encryption";
import { notifyHeadsUp } from "../../src/services/notifications";
import { finishRun } from "../../src/services/run-lifecycle";
import type { TelegramSendResult } from "../../src/lib/telegram";
import {
  closeTestServer,
  createUser,
  resetDatabase,
  setupDatabase,
  startTestServer,
} from "./harness";

// Phase 16D — the evening heads-up. The "once per user per day" property IS a
// database unique index, so this runs against the real sprout_test database.
//
// The heads-up is the human cross-check: it names the NEXT workday's decision
// after the clock-out run finishes, so a wrong holiday call can be fixed in the
// calendar before it becomes a false record.

const FAKE_TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"; // gitleaks:allow
const FAKE_CHAT_ID = "123456789";

// Noon Manila on the day the heads-up is SENT.
const FRI_BEFORE_HEROES = new Date("2026-08-28T04:00:00Z"); // Fri 28 Aug 2026
const SUNDAY_BEFORE_ALL_SOULS = new Date("2026-11-01T04:00:00Z"); // Sun 1 Nov 2026
const TUESDAY = new Date("2026-08-11T04:00:00Z"); // Tue 11 Aug 2026

type SendFn = (
  botToken: string,
  chatId: string,
  html: string,
) => Promise<TelegramSendResult>;

function makeSend(calls: string[]): SendFn {
  return async (_botToken, _chatId, html) => {
    calls.push(html);
    return { ok: true } as TelegramSendResult;
  };
}

describe("the evening heads-up (16D)", () => {
  beforeAll(async () => {
    // The run-finished and retry dispatches use the REAL transport; point it at
    // a dead port so this file never reaches api.telegram.org.
    process.env["TELEGRAM_API_BASE"] = "http://127.0.0.1:9";
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

  async function setupNotifications(
    userId: string,
    notifyHeadsUpEnabled = true,
  ): Promise<void> {
    await db.insert(notificationSettings).values({
      userId,
      telegramBotTokenEnc: encrypt(FAKE_TOKEN),
      telegramChatId: FAKE_CHAT_ID,
      enabled: true,
      notifyHeadsUp: notifyHeadsUpEnabled,
    });
  }

  async function userWithSchedule(
    toggle = true,
  ): Promise<{ userId: string }> {
    const { user } = await createUser();
    await db.insert(schedules).values({
      userId: user.id,
      clockInTime: "05:30:00",
      clockOutTime: "16:15:00",
      enabled: true,
    });
    await setupNotifications(user.id, toggle);
    return { userId: user.id };
  }

  // --- the message -----------------------------------------------------------

  it("names the next workday across a weekend and a holiday", async () => {
    const { userId } = await userWithSchedule();
    const calls: string[] = [];

    // Friday. Tomorrow is Saturday, Sunday is the weekend, and Monday 31 Aug is
    // National Heroes' Day (public) — so the next clock-in is Tuesday.
    const out = await notifyHeadsUp(
      { userId, now: FRI_BEFORE_HEROES },
      makeSend(calls),
    );

    expect(out).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("Heads-up");
    expect(calls[0]).toContain("weekend"); // tomorrow's reason
    expect(calls[0]).toContain("Tue"); // the next workday
    expect(calls[0]).toContain("05:30"); // the user's clock-in time
    expect(calls[0]).toContain("http"); // the dashboard link
  });

  it("names tomorrow when tomorrow IS a workday", async () => {
    const { userId } = await userWithSchedule();
    const calls: string[] = [];

    const out = await notifyHeadsUp({ userId, now: TUESDAY }, makeSend(calls));

    expect(out).toBe("sent");
    expect(calls[0]).toContain("Next: Wed 12 Aug 05:30 clock-in.");
  });

  it("calls out a holiday the user marked as a workday", async () => {
    const { userId } = await userWithSchedule();
    // 2026-11-02 (Monday) is All Souls' Day in the library; the user overrode it.
    await db.insert(dayOverrides).values({
      userId,
      manilaDate: "2026-11-02",
      kind: "work",
      note: null,
    });
    const calls: string[] = [];

    const out = await notifyHeadsUp(
      { userId, now: SUNDAY_BEFORE_ALL_SOULS },
      makeSend(calls),
    );

    expect(out).toBe("sent");
    expect(calls[0]).toContain(
      "Mon 2 Nov is a day you marked as a workday",
    );
    expect(calls[0]).toContain("05:30");
  });

  // --- once per day ----------------------------------------------------------

  it("sends once per user per day, however many clock-out runs finish", async () => {
    const { userId } = await userWithSchedule();
    const calls: string[] = [];

    const first = await notifyHeadsUp(
      { userId, now: FRI_BEFORE_HEROES },
      makeSend(calls),
    );
    const second = await notifyHeadsUp(
      { userId, now: FRI_BEFORE_HEROES },
      makeSend(calls),
    );

    expect(first).toBe("sent");
    expect(second).toBe("skipped");
    expect(calls).toHaveLength(1);

    const rows = await db
      .select()
      .from(headsUpNotices)
      .where(eq(headsUpNotices.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.manilaDate).toBe("2026-08-28");
  });

  it("is muted by the notify_heads_up toggle", async () => {
    const { userId } = await userWithSchedule(false);
    const calls: string[] = [];

    const out = await notifyHeadsUp(
      { userId, now: FRI_BEFORE_HEROES },
      makeSend(calls),
    );

    expect(out).toBe("skipped");
    expect(calls).toHaveLength(0);
  });

  // --- the lifecycle trigger -------------------------------------------------

  it("a CLOCK-OUT run reaching an outcome triggers exactly one heads-up", async () => {
    const { userId } = await userWithSchedule();
    const [run] = await db
      .insert(runs)
      .values({ userId, action: "out", status: "pending" })
      .returning();
    expect(run).toBeDefined();

    const headsUp = vi.fn(
      async (_params: { userId: string; now: Date }) => "sent" as const,
    );
    await finishRun(
      { run: run!, status: "success" },
      { now: FRI_BEFORE_HEROES, deps: { notifyHeadsUp: headsUp } },
    );

    expect(headsUp).toHaveBeenCalledTimes(1);
    expect(headsUp.mock.calls[0]![0]).toMatchObject({ userId });
  });

  it("a CLOCK-IN run does NOT trigger a heads-up", async () => {
    const { userId } = await userWithSchedule();
    const [run] = await db
      .insert(runs)
      .values({ userId, action: "in", status: "pending" })
      .returning();

    const headsUp = vi.fn(async () => "sent" as const);
    await finishRun(
      { run: run!, status: "success" },
      { now: FRI_BEFORE_HEROES, deps: { notifyHeadsUp: headsUp } },
    );

    expect(headsUp).not.toHaveBeenCalled();
  });

  it("a failed clock-out still heads up (any status), and a retry does not duplicate it", async () => {
    const { userId } = await userWithSchedule();
    const [run] = await db
      .insert(runs)
      .values({ userId, action: "out", status: "pending" })
      .returning();

    // The REAL notifier this time, so the database ledger arbitrates. The
    // lifecycle fires it fire-and-forget, so collect the promises and await
    // them before asserting.
    const calls: string[] = [];
    const inFlight: Promise<unknown>[] = [];
    const headsUp = (p: { userId: string; now: Date }) => {
      const promise = notifyHeadsUp(p, makeSend(calls));
      inFlight.push(promise);
      return promise;
    };

    await finishRun(
      { run: run!, status: "failure", error: "boom" },
      { now: FRI_BEFORE_HEROES, deps: { notifyHeadsUp: headsUp } },
    );
    await Promise.all(inFlight);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("Heads-up");

    // A second out-run finishing the same Manila day must not repeat it.
    const [retryRun] = await db
      .insert(runs)
      .values({ userId, action: "out", status: "pending", attempt: 1 })
      .returning();
    await finishRun(
      { run: retryRun!, status: "success" },
      { now: FRI_BEFORE_HEROES, deps: { notifyHeadsUp: headsUp } },
    );
    await Promise.all(inFlight);
    expect(calls).toHaveLength(1);
  });
});
