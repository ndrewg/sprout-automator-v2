import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../src/db/client";
import { auditLog, dayOverrides, runs, schedules } from "../../src/db/schema";
import { addManilaDays, manilaDateString } from "../../src/services/workday";
import { hasPendingRetry } from "../../src/services/retry-state";
import {
  closeTestServer,
  createUser,
  request,
  resetDatabase,
  setupDatabase,
  startTestServer,
} from "./harness";

// Phase 16B — the day-override API. Tenant isolation and the unique-per-day
// upsert are DB mechanisms, so this runs against the real sprout_test database.

type DayView = {
  date: string;
  work: boolean;
  reason: {
    code: string;
    label: string;
    holidayName?: string;
    holidayType?: string;
    holidaySource?: string;
    note?: string | null;
  };
  override: { kind: "skip" | "work"; note: string | null } | null;
};

type DaysBody = { days: DayView[] };
type DayBody = { day: DayView };

const REAL_WORKDAY = "2026-08-11"; // Tuesday, no PH holiday

/**
 * The first future WORK day per the API. The round-trip test needs a day whose
 * cleared decision is "work", and "today + 3" can land on a weekend or a
 * holiday — so ask the gate rather than guess.
 */
async function firstFutureWorkday(
  cookie: string,
  from: string,
): Promise<string> {
  const res = await request(
    `/schedule/days?from=${from}&to=${addManilaDays(from, 14)}`,
    { cookie },
  );
  const { days } = res.body as DaysBody;
  const found = days.find((d) => d.work);
  if (!found) throw new Error("no future workday in the next two weeks");
  return found.date;
}

describe("day overrides (16B)", () => {
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

  // --- round-trip -----------------------------------------------------------

  it("sets, replaces and clears an override", async () => {
    const { cookie } = await createUser();
    const day = await firstFutureWorkday(
      cookie,
      addManilaDays(manilaDateString(new Date()), 1),
    );

    // Set: skip.
    const set = await request(`/schedule/days/${day}`, {
      cookie,
      method: "PUT",
      body: { kind: "skip", note: "dentist" },
    });
    expect(set.status).toBe(200);
    let body = set.body as DayBody;
    expect(body.day.date).toBe(day);
    expect(body.day.work).toBe(false);
    expect(body.day.reason.code).toBe("skip_day");
    expect(body.day.override).toEqual({ kind: "skip", note: "dentist" });

    // Replace: the other kind wins, and there is still exactly one row.
    const replace = await request(`/schedule/days/${day}`, {
      cookie,
      method: "PUT",
      body: { kind: "work" },
    });
    expect(replace.status).toBe(200);
    body = replace.body as DayBody;
    expect(body.day.work).toBe(true);
    expect(body.day.reason.code).toBe("work_override");
    expect(body.day.override).toEqual({ kind: "work", note: null });

    // Clear: no override, back to the gate's own answer.
    const clear = await request(`/schedule/days/${day}`, {
      cookie,
      method: "DELETE",
    });
    expect(clear.status).toBe(200);
    body = clear.body as DayBody;
    expect(body.day.override).toBeNull();
    expect(body.day.work).toBe(true);

    const rows = await db.select().from(dayOverrides);
    expect(rows).toHaveLength(0);
  });

  it("clearing a day that has no override is a harmless no-op", async () => {
    const { cookie } = await createUser();
    const day = addManilaDays(manilaDateString(new Date()), 4);
    const res = await request(`/schedule/days/${day}`, {
      cookie,
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    // No audit row for a no-op clear.
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "day_override_cleared"));
    expect(audits).toHaveLength(0);
  });

  // --- validation -----------------------------------------------------------

  it("rejects a past date on set and on clear", async () => {
    const { cookie } = await createUser();
    const past = addManilaDays(manilaDateString(new Date()), -1);

    const put = await request(`/schedule/days/${past}`, {
      cookie,
      method: "PUT",
      body: { kind: "skip" },
    });
    expect(put.status).toBe(400);

    const del = await request(`/schedule/days/${past}`, {
      cookie,
      method: "DELETE",
    });
    expect(del.status).toBe(400);
  });

  it("today counts as allowed", async () => {
    const { cookie } = await createUser();
    const today = manilaDateString(new Date());
    const res = await request(`/schedule/days/${today}`, {
      cookie,
      method: "PUT",
      body: { kind: "skip" },
    });
    expect(res.status).toBe(200);
    expect((res.body as DayBody).day.date).toBe(today);
  });

  it("rejects a malformed date, an unknown kind, a long note and unknown fields", async () => {
    const { cookie } = await createUser();
    const day = addManilaDays(manilaDateString(new Date()), 2);

    expect(
      (await request(`/schedule/days/not-a-date`, { cookie, method: "PUT", body: { kind: "skip" } })).status,
    ).toBe(400);
    expect(
      (await request(`/schedule/days/2026-02-31`, { cookie, method: "PUT", body: { kind: "skip" } })).status,
    ).toBe(400);
    expect(
      (await request(`/schedule/days/${day}`, { cookie, method: "PUT", body: { kind: "holiday" } })).status,
    ).toBe(400);
    expect(
      (await request(`/schedule/days/${day}`, { cookie, method: "PUT", body: { kind: "skip", note: "x".repeat(101) } })).status,
    ).toBe(400);
    expect(
      (await request(`/schedule/days/${day}`, { cookie, method: "PUT", body: { kind: "skip", bogus: 1 } })).status,
    ).toBe(400);
  });

  it("rejects a range that is reversed, missing or over the 92-day cap", async () => {
    const { cookie } = await createUser();
    expect((await request("/schedule/days", { cookie })).status).toBe(400);
    expect(
      (await request("/schedule/days?from=2026-08-10", { cookie })).status,
    ).toBe(400);
    expect(
      (
        await request("/schedule/days?from=2026-08-20&to=2026-08-10", {
          cookie,
        })
      ).status,
    ).toBe(400);
    // 2026-01-01 .. 2026-06-30 is 181 days.
    expect(
      (
        await request("/schedule/days?from=2026-01-01&to=2026-06-30", {
          cookie,
        })
      ).status,
    ).toBe(400);
    // Exactly 92 days is allowed.
    expect(
      (
        await request("/schedule/days?from=2026-08-01&to=2026-10-31", {
          cookie,
        })
      ).status,
    ).toBe(200);
  });

  // --- the range reads back the gate's answers ------------------------------

  it("reasons match the gate for two weeks covering a weekend, a holiday, an override and a pause", async () => {
    const { user, cookie } = await createUser();
    // A pause window on two plain weekdays.
    await db.insert(schedules).values({
      userId: user.id,
      clockInTime: "05:30:00",
      clockOutTime: "18:05:00",
      enabled: true,
      pausedFrom: "2026-08-26",
      pausedUntil: "2026-08-27",
    });
    // Work anyway on a library holiday (2026-08-21 = Ninoy Aquino Day), and a
    // skip on a plain workday (2026-08-25 = Tuesday).
    await db.insert(dayOverrides).values([
      { userId: user.id, manilaDate: "2026-08-21", kind: "work", note: null },
      { userId: user.id, manilaDate: "2026-08-25", kind: "skip", note: "leave" },
    ]);

    const res = await request("/schedule/days?from=2026-08-07&to=2026-08-31", {
      cookie,
    });
    expect(res.status).toBe(200);
    const { days } = res.body as DaysBody;
    expect(days).toHaveLength(25);
    const byDate = new Map(days.map((d) => [d.date, d]));

    expect(byDate.get("2026-08-08")?.reason.code).toBe("weekend"); // Saturday
    expect(byDate.get(REAL_WORKDAY)?.reason.code).toBe("workday"); // Tuesday
    expect(byDate.get("2026-08-25")?.reason.code).toBe("skip_day"); // the override
    expect(byDate.get("2026-08-25")?.override?.note).toBe("leave");
    expect(byDate.get("2026-08-26")?.reason.code).toBe("paused");
    expect(byDate.get("2026-08-21")?.reason.code).toBe("work_override"); // holiday, worked
    expect(byDate.get("2026-08-21")?.work).toBe(true);
    expect(byDate.get("2026-08-31")?.reason.code).toBe("holiday"); // National Heroes' Day
    expect(byDate.get("2026-08-31")?.reason.holidayType).toBe("public");
  });

  // --- tenant isolation -----------------------------------------------------

  it("another user cannot see or disturb the overrides", async () => {
    const { cookie: cookieA } = await createUser();
    const { cookie: cookieB } = await createUser();
    const day = addManilaDays(manilaDateString(new Date()), 5);

    await request(`/schedule/days/${day}`, {
      cookie: cookieA,
      method: "PUT",
      body: { kind: "skip" },
    });

    // B sees its own (empty) calendar.
    const asB = await request(
      `/schedule/days?from=${day}&to=${day}`,
      { cookie: cookieB },
    );
    expect(asB.status).toBe(200);
    const bDays = (asB.body as DaysBody).days;
    expect(bDays).toHaveLength(1);
    expect(bDays[0]!.override).toBeNull();

    // B setting the same day does not touch A's row, and B clearing it does not
    // remove A's.
    await request(`/schedule/days/${day}`, {
      cookie: cookieB,
      method: "PUT",
      body: { kind: "work" },
    });
    await request(`/schedule/days/${day}`, {
      cookie: cookieB,
      method: "DELETE",
    });

    const asA = await request(`/schedule/days?from=${day}&to=${day}`, {
      cookie: cookieA,
    });
    expect((asA.body as DaysBody).days[0]!.override?.kind).toBe("skip");
  });

  // --- audit ----------------------------------------------------------------

  it("audits the set without ever recording the note text", async () => {
    const { user, cookie } = await createUser();
    const day = addManilaDays(manilaDateString(new Date()), 6);
    const SECRET_NOTE = "pharmacy run for a private prescription";

    await request(`/schedule/days/${day}`, {
      cookie,
      method: "PUT",
      body: { kind: "skip", note: SECRET_NOTE },
    });

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.userId, user.id),
          eq(auditLog.eventType, "day_override_set"),
        ),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(audit).toBeDefined();
    const metadata = JSON.stringify(audit?.metadata ?? {});
    expect(metadata).toContain(day);
    expect(metadata).toContain("skip");
    expect(metadata).not.toContain(SECRET_NOTE);
  });

  // --- today's retry --------------------------------------------------------

  it("setting today's override to skip cancels today's pending retry", async () => {
    const { user, cookie } = await createUser();
    const today = manilaDateString(new Date());
    const [run] = await db
      .insert(runs)
      .values({
        userId: user.id,
        action: "in",
        status: "failure",
        attempt: 0,
        error: "boom",
        startedAt: new Date(),
        retryAt: new Date(),
      })
      .returning();
    expect(run).toBeDefined();
    expect(await hasPendingRetry(user.id, "in", today)).toBe(true);

    const res = await request(`/schedule/days/${today}`, {
      cookie,
      method: "PUT",
      body: { kind: "skip" },
    });
    expect(res.status).toBe(200);
    expect(await hasPendingRetry(user.id, "in", today)).toBe(false);
  });

  it("setting today's override to WORK leaves the retry alone", async () => {
    const { user, cookie } = await createUser();
    const today = manilaDateString(new Date());
    await db.insert(runs).values({
      userId: user.id,
      action: "in",
      status: "failure",
      attempt: 0,
      error: "boom",
      startedAt: new Date(),
      retryAt: new Date(),
    });

    await request(`/schedule/days/${today}`, {
      cookie,
      method: "PUT",
      body: { kind: "work" },
    });
    expect(await hasPendingRetry(user.id, "in", today)).toBe(true);
  });
});
