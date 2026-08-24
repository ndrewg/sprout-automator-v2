import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client";
import { gazetteHolidays, notificationSettings } from "../../src/db/schema";
import { encrypt } from "../../src/lib/encryption";
import { resolveHolidayDecision } from "../../src/services/holidays";
import { notifyHolidaySkip } from "../../src/services/notifications";
import { refreshGazetteCache } from "../../src/services/gazette";
import type { TelegramSendResult } from "../../src/lib/telegram";
import {
  closeTestServer,
  createUser,
  resetDatabase,
  setupDatabase,
  startTestServer,
} from "./harness";

// 13B — the Official Gazette advisory layer, proven against the real database.
// Covers the merge rules (override > library > gazette, gazette additive-only),
// the locality trap (national skips, city/ambiguous notify-but-do-not-skip),
// the lunar-date disagreement, and fetch-failure isolation (hard rule 11).

const FAKE_TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"; // gitleaks:allow
const FAKE_CHAT_ID = "123456789";

// Noon Manila on the target calendar day, so manilaDateString(now) is stable.
const NINO = new Date("2026-08-21T04:00:00Z"); // Ninoy Aquino Day (library optional)
const EID_GAZETTE = new Date("2026-03-21T04:00:00Z"); // gazette's proclaimed Eid

type SendFn = (
  botToken: string,
  chatId: string,
  html: string,
) => Promise<TelegramSendResult>;

describe("holiday sourcing — orchestrator + gazette cache (13A/13B)", () => {
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

  async function seedGazette(rows: {
    manilaDate: string;
    name: string;
    scope: "national" | "regional" | "ambiguous";
  }[]): Promise<void> {
    for (const r of rows) {
      await db.insert(gazetteHolidays).values({
        manilaDate: r.manilaDate,
        name: r.name,
        scope: r.scope,
        proclamationNo: null,
      });
    }
  }

  describe("resolveHolidayDecision — the merge rules", () => {
    it("a cached NATIONAL proclamation adds a skip (source gazette)", async () => {
      await seedGazette([
        { manilaDate: "2026-09-04", name: "Proclamation Day", scope: "national" },
      ]);
      const d = await resolveHolidayDecision(new Date("2026-09-04T04:00:00Z"));
      expect(d.skip).not.toBeNull();
      expect(d.skip?.source).toBe("gazette");
      expect(d.skip?.name).toContain("Proclamation Day");
      expect(d.possible).toBeNull();
    });

    it("a CITY-SCOPED proclamation does NOT skip — it surfaces as a possible holiday", async () => {
      await seedGazette([
        { manilaDate: "2026-09-04", name: "Manila City Day", scope: "regional" },
      ]);
      const d = await resolveHolidayDecision(new Date("2026-09-04T04:00:00Z"));
      expect(d.skip).toBeNull();
      expect(d.possible).not.toBeNull();
      expect(d.possible?.source).toBe("gazette");
    });

    it("an AMBIGUOUS-scope proclamation notifies but does NOT skip", async () => {
      await seedGazette([
        { manilaDate: "2026-09-04", name: "Mystery Day", scope: "ambiguous" },
      ]);
      const d = await resolveHolidayDecision(new Date("2026-09-04T04:00:00Z"));
      expect(d.skip).toBeNull();
      expect(d.possible).not.toBeNull();
    });

    it("the gazette layer can NEVER cancel a library skip (additive-only)", async () => {
      // 2026-08-21 is a library `optional` holiday (Ninoy Aquino Day). Seed a
      // gazette entry for the same date with an ambiguous scope — it must not
      // remove or downgrade the library skip.
      await seedGazette([
        { manilaDate: "2026-08-21", name: "Something Else", scope: "ambiguous" },
      ]);
      const d = await resolveHolidayDecision(NINO);
      expect(d.skip).not.toBeNull();
      expect(d.skip?.source).toBe("library");
      expect(d.skip?.name).toBe("Ninoy Aquino Day");
    });

    it("the gazette layer can NEVER cancel an override skip (additive-only)", async () => {
      process.env["EXTRA_HOLIDAYS"] = "2026-09-04=Operator Day";
      // A gazette regional entry on the same date must not cancel the override.
      await seedGazette([
        { manilaDate: "2026-09-04", name: "City Whatever", scope: "regional" },
      ]);
      const d = await resolveHolidayDecision(new Date("2026-09-04T04:00:00Z"));
      expect(d.skip).not.toBeNull();
      expect(d.skip?.source).toBe("override");
      expect(d.skip?.name).toBe("Operator Day");
    });

    it("a Gazette Eid differing from the library skips on the Gazette date and flags the disagreement", async () => {
      // Library has Eid'l Fitr on 2026-03-20 (public). Gazette proclaims it on
      // 2026-03-21 (national).
      await seedGazette([
        { manilaDate: "2026-03-21", name: "Eid'l Fitr", scope: "national" },
      ]);
      const d = await resolveHolidayDecision(EID_GAZETTE);
      expect(d.skip).not.toBeNull();
      expect(d.skip?.source).toBe("gazette");
      expect(d.skip?.name.toLowerCase()).toContain("eid");
      expect(d.disagreementNote).not.toBeNull();
      expect(d.disagreementNote).toContain("2026-03-20");
      expect(d.disagreementNote).toContain("looks wrong");
    });

    it("an EXTRA_HOLIDAYS override adds a skip (source override)", async () => {
      process.env["EXTRA_HOLIDAYS"] = "2026-11-20=Special Day";
      const d = await resolveHolidayDecision(new Date("2026-11-20T04:00:00Z"));
      expect(d.skip).not.toBeNull();
      expect(d.skip?.source).toBe("override");
      expect(d.skip?.name).toBe("Special Day");
    });

    it("an EXTRA_HOLIDAYS override WINS over the library for the same date", async () => {
      // 2026-12-25 is Christmas Day in the library. An override for the same
      // date must report the override, not the library.
      process.env["EXTRA_HOLIDAYS"] = "2026-12-25=Operator Christmas";
      const d = await resolveHolidayDecision(new Date("2026-12-25T04:00:00Z"));
      expect(d.skip).not.toBeNull();
      expect(d.skip?.source).toBe("override");
      expect(d.skip?.name).toBe("Operator Christmas");
    });

    it("unset EXTRA_HOLIDAYS with no gazette = today's behaviour", async () => {
      const d = await resolveHolidayDecision(new Date("2026-03-10T04:00:00Z"));
      expect(d.skip).toBeNull();
      expect(d.possible).toBeNull();
      expect(d.disagreementNote).toBeNull();
    });
  });

  describe("notifyHolidaySkip — always notifies for override/gazette", () => {
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

    it("notifies for an override skip even though its type is public", async () => {
      const { user } = await createUser();
      await setupNotifications(user.id);
      const calls: string[] = [];
      const out = await notifyHolidaySkip(
        user.id,
        { name: "Special Day", type: "public", source: "override" },
        new Date("2026-11-20T04:00:00Z"),
        makeSend(calls),
      );
      expect(out).toBe("sent");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("Special Day");
      expect(calls[0]).toContain("operator override");
    });

    it("notifies for a gazette skip, naming the proclamation", async () => {
      const { user } = await createUser();
      await setupNotifications(user.id);
      const calls: string[] = [];
      const out = await notifyHolidaySkip(
        user.id,
        { name: "Eid'l Fitr", type: "public", source: "gazette" },
        EID_GAZETTE,
        makeSend(calls),
      );
      expect(out).toBe("sent");
      expect(calls[0]).toContain("Eid'l Fitr");
      expect(calls[0]).toContain("Official Gazette proclamation");
    });

    it("notifies a POSSIBLE holiday without skipping", async () => {
      const { user } = await createUser();
      await setupNotifications(user.id);
      const calls: string[] = [];
      const out = await notifyHolidaySkip(
        user.id,
        { name: "Manila City Day", type: "optional", source: "gazette" },
        new Date("2026-09-04T04:00:00Z"),
        { possible: true },
        makeSend(calls),
      );
      expect(out).toBe("sent");
      expect(calls[0]).toContain("Possible holiday");
      expect(calls[0]).toContain("Manila City Day");
    });

    it("the Gazette disagreement note is appended to the skip notification", async () => {
      const { user } = await createUser();
      await setupNotifications(user.id);
      const calls: string[] = [];
      const out = await notifyHolidaySkip(
        user.id,
        { name: "Eid'l Fitr", type: "public", source: "gazette" },
        EID_GAZETTE,
        {
          note: "The bundled calendar placed Eid'l Fitr on 2026-03-20, but the Official Gazette proclaims 2026-03-21. The library's date looks wrong.",
        },
        makeSend(calls),
      );
      expect(out).toBe("sent");
      expect(calls[0]).toContain("2026-03-20");
      expect(calls[0]).toContain("looks wrong");
    });
  });

  describe("fetch isolation (hard rule 11)", () => {
    it("a fetch that throws leaves the previous cache intact", async () => {
      // Seed a cache first (as if a prior successful fetch had run).
      await seedGazette([
        { manilaDate: "2026-09-04", name: "Known Day", scope: "national" },
      ]);
      const failingFetch = async () => {
        throw new Error("connection refused");
      };
      await refreshGazetteCache(failingFetch);
      // The cache still has the prior entry.
      const rows = await db
        .select()
        .from(gazetteHolidays)
        .where(eq(gazetteHolidays.manilaDate, "2026-09-04"));
      expect(rows.length).toBe(1);
      expect(rows[0]?.name).toBe("Known Day");
    });

    it("a scheduled run is unaffected by a gazette fetch failure", async () => {
      // Prove the decision path (what the scheduler calls) still resolves to a
      // normal workday after a failed refresh, and the cache is untouched.
      await seedGazette([
        { manilaDate: "2026-09-07", name: "Some Day", scope: "regional" },
      ]);
      const failingFetch = async () => {
        throw new Error("network down");
      };
      await refreshGazetteCache(failingFetch);

      // A workday with no skip resolves as today — no throw, no skip.
      const d = await resolveHolidayDecision(new Date("2026-09-07T04:00:00Z"));
      expect(d.skip).toBeNull();
      // The previous cache (regional) is still there and still does not skip.
      expect(d.possible).not.toBeNull();
    });
  });
});
