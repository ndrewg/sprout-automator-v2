import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/db/client";
import {
  missedRunNotices,
  notificationSettings,
  runs,
  schedules,
  users,
} from "../../src/db/schema";
import { encrypt } from "../../src/lib/encryption";
import { executeQueuedRun, startRun } from "../../src/services/runs";
import { runAutomation } from "../../src/automation/runAutomation";
import {
  attemptRun,
  currentPolicy,
  scheduleRetryOnFailure,
} from "../../src/services/retry";
import {
  cancelPendingRetry,
  clearPendingRetries,
  hasPendingRetry,
  pendingAttempt,
  scheduleOneShotRetry,
} from "../../src/services/retry-registry";
import {
  defaultSweepDeps,
  sweepMissedRuns,
} from "../../src/services/notifications";
import {
  closeTestServer,
  createUser,
  request,
  resetDatabase,
  setupDatabase,
  startTestServer,
} from "./harness";

// Phase 14 integration tests. The retry decision is exercised against the real
// database (runs, users.retryIntroShown, the partial unique index) and the real
// in-memory registry, with the automation itself mocked so no Chromium
// launches. The wall-clock cutoff is time-of-day dependent, so scheduling
// scenarios inject a MORNING anchor (todayAtManila) — a clock-in retry in the
// afternoon is correctly refused, and the tests must not depend on when the
// suite happens to run.
vi.mock("../../src/automation/runAutomation", () => ({
  runAutomation: vi
    .fn()
    .mockRejectedValue(new Error("boom: HRHub unreachable")),
}));

// dispatch is wrapped in a recording mock that CALLS THROUGH to the real
// implementation (settings lookup, blocked-count, Telegram transport), so every
// retry-scheduled / give-up message is observable without changing behaviour.
vi.mock("../../src/services/notifications", async (importOriginal) => {
  const mod =
    await importOriginal<typeof import("../../src/services/notifications")>();
  return {
    ...mod,
    dispatch: vi.fn(mod.dispatch),
  };
});
import * as notificationsModule from "../../src/services/notifications";

const todayStr = (): string => {
  const now = new Date();
  const m = `${now.getMonth() + 1}`.padStart(2, "0");
  const d = `${now.getDate()}`.padStart(2, "0");
  return `${now.getFullYear()}-${m}-${d}`;
};

/** The instant whose Manila wall clock is TODAY at hour:minute (Manila = UTC+8,
 *  so the UTC instant is wall - 8h; Date.UTC normalizes negative hours). */
function todayAtManila(hour: number, minute: number): Date {
  const now = new Date();
  const manilaDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const [y, m, d] = manilaDate.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, hour - 8, minute));
}

async function userWithCredentials(): Promise<{ userId: string; cookie: string }> {
  const { user, cookie } = await createUser();
  await request("/credentials", {
    cookie,
    method: "PUT",
    body: { sproutUsername: "retry-user", sproutPassword: "sprout-pass-1234" },
  });
  return { userId: user.id, cookie };
}

async function lastRun(
  userId: string,
  action: "in" | "out",
  attempt: number,
): Promise<{ id: string; status: string } | undefined> {
  const [row] = await db
    .select({ id: runs.id, status: runs.status })
    .from(runs)
    .where(and(eq(runs.userId, userId), eq(runs.action, action), eq(runs.attempt, attempt)))
    .orderBy(runs.startedAt)
    .limit(1);
  return row;
}

/** Insert a real FAILED run row for (user, action, attempt), failing at the
 *  Manila instant `at`. Returns the row, ready for scheduleRetryOnFailure. */
async function insertFailedRun(
  userId: string,
  action: "in" | "out",
  attempt: number,
  at: Date,
) {
  const [row] = await db
    .insert(runs)
    .values({
      userId,
      action,
      status: "failure",
      attempt,
      error: "boom: HRHub unreachable",
      startedAt: at,
      finishedAt: at,
    })
    .returning();
  if (!row) throw new Error("insertFailedRun: insert returned no row");
  return row;
}

/** The "will retry" dispatches (the retry-scheduled message). */
function retryScheduledDispatches(): string[] {
  return (
    notificationsModule.dispatch as unknown as ReturnType<typeof vi.fn>
  ).mock.calls
    .map((c) => c[1] as string)
    .filter((html) => typeof html === "string" && html.includes("will retry"));
}

/** The give-up dispatches. */
function giveUpDispatches(): string[] {
  return (
    notificationsModule.dispatch as unknown as ReturnType<typeof vi.fn>
  ).mock.calls
    .map((c) => c[1] as string)
    .filter((html) => typeof html === "string" && html.includes("gave up"));
}

describe("retry on transient failure", () => {
  beforeAll(async () => {
    await setupDatabase();
    await startTestServer();
  });
  beforeEach(async () => {
    await resetDatabase();
    clearPendingRetries();
    (
      notificationsModule.dispatch as unknown as ReturnType<typeof vi.fn>
    ).mockClear();
  });
  afterEach(() => {
    clearPendingRetries();
    delete process.env["EXTRA_HOLIDAYS"];
  });
  afterAll(async () => {
    await closeTestServer();
  });

  describe("the hard constraint: retry `failure` only, never `skipped`", () => {
    it("a failure schedules exactly one retry", async () => {
      const { userId } = await userWithCredentials();
      // Real flow: the run fails through the actual queue executor.
      const started = await startRun({ userId, action: "in" });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      const run = await lastRun(userId, "in", 0);
      if (!run) throw new Error("expected an attempt-0 run");
      await executeQueuedRun(run.id);

      const [failed] = await db
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.id, run.id))
        .limit(1);
      expect(failed?.status).toBe("failure");

      // The scheduling decision, anchored at a morning failure.
      const morning = todayAtManila(5, 35);
      const failedRow = await getRunRow(run.id);
      if (!failedRow) throw new Error("expected the failed run row");
      await scheduleRetryOnFailure(failedRow, morning);

      await vi.waitFor(() => {
        expect(hasPendingRetry(userId, "in", todayStr())).toBe(true);
      });
      expect(pendingAttempt(userId, "in", todayStr())).toBe(1);

      // Calling again for the same run must not stack a second retry.
      await scheduleRetryOnFailure(failedRow, morning);
      expect(pendingAttempt(userId, "in", todayStr())).toBe(1);

      // ONE "will retry" message naming the next attempt time (06:05). The
      // dispatch is fire-and-forget, so wait for it.
      await vi.waitFor(() => {
        expect(retryScheduledDispatches().length).toBe(1);
      });
      const scheduled = retryScheduledDispatches();
      expect(scheduled[0]).toContain("06:05");
    });

    it("a skipped run schedules ZERO retries (the double-clock guard)", async () => {
      const { userId } = await userWithCredentials();
      // Real flow: the run is skipped through the actual queue executor.
      const started = await startRun({ userId, action: "in" });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      const run = await lastRun(userId, "in", 0);
      if (!run) throw new Error("expected an attempt-0 run");

      vi.mocked(runAutomation).mockResolvedValue({
        success: true,
        skipped: true,
        loginMethod: "saved_session",
        skipReason: "already clocked in",
      });
      await executeQueuedRun(run.id);

      // The most important assertion in the phase: a skip must never queue a
      // retry — retrying a skip would risk a double clock.
      expect(hasPendingRetry(userId, "in", todayStr())).toBe(false);
      expect(pendingAttempt(userId, "in", todayStr())).toBeUndefined();
      const [row] = await db
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.id, run.id))
        .limit(1);
      expect(row?.status).toBe("skipped");

      // And the scheduling entry point itself refuses a skipped run.
      const skippedRow = await getRunRow(run.id);
      if (!skippedRow) throw new Error("expected the skipped run row");
      await scheduleRetryOnFailure(
        { ...skippedRow, status: "skipped" },
        todayAtManila(5, 35),
      );
      expect(hasPendingRetry(userId, "in", todayStr())).toBe(false);
    });
  });

  describe("the two brakes", () => {
    it("the cap holds: N attempts then ONE give-up message, silence between attempts", async () => {
      const { userId } = await userWithCredentials();
      const policy = currentPolicy();
      const t0 = todayAtManila(5, 35);

      // attempt 0 fails at 05:35 -> schedules attempt 1.
      const r0 = await insertFailedRun(userId, "in", 0, t0);
      await scheduleRetryOnFailure(r0, t0);
      await vi.waitFor(() => {
        expect(hasPendingRetry(userId, "in", todayStr())).toBe(true);
      });
      expect(pendingAttempt(userId, "in", todayStr())).toBe(1);
      // The first-failure message is fire-and-forget, so wait for it.
      await vi.waitFor(() => {
        expect(retryScheduledDispatches().length).toBe(1);
      });

      // Each retry fires 30 min later and fails at that instant.
      for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
        const at = todayAtManila(5, 5 + 30 * attempt);
        // The pending attempt is consumed when it fires (attemptRun cancels it).
        cancelPendingRetry(userId, "in", todayStr());
        const rN = await insertFailedRun(userId, "in", attempt, at);
        await scheduleRetryOnFailure(rN, at);
        if (attempt < policy.maxAttempts) {
          // Intermediate attempts: STILL no give-up (silence between attempts).
          await vi.waitFor(() => {
            expect(pendingAttempt(userId, "in", todayStr())).toBe(attempt + 1);
          });
          expect(giveUpDispatches().length).toBe(0);
        }
      }

      // After the max attempt: no pending retry, exactly ONE give-up message.
      await vi.waitFor(() => {
        expect(hasPendingRetry(userId, "in", todayStr())).toBe(false);
      });
      const giveUps = giveUpDispatches();
      expect(giveUps.length).toBe(1);
      expect(giveUps[0]).toContain(`failed ${policy.maxAttempts} times`);

      // One row per attempt (original + N retries), all terminal, none active.
      const rows = await db
        .select({ attempt: runs.attempt, status: runs.status })
        .from(runs)
        .where(and(eq(runs.userId, userId), eq(runs.action, "in")));
      expect(rows).toHaveLength(policy.maxAttempts + 1);
      for (const r of rows) expect(r.status).toBe("failure");
      expect(
        rows.some((r) => r.status === "pending" || r.status === "running"),
      ).toBe(false);
    });

    it("the cutoff holds independently of the cap (integration)", async () => {
      const { userId } = await userWithCredentials();
      // A clock-in failure at 11:45 Manila with the default 30 min interval
      // would retry at 12:15 — past the 12:00 clock-in cutoff. No retry is
      // scheduled even though attempt 0 < maxAttempts (the cap alone would
      // allow it).
      const at = new Date("2026-08-10T11:45:00+08:00");
      const r0 = await insertFailedRun(userId, "in", 0, at);
      await scheduleRetryOnFailure(r0, at);

      expect(hasPendingRetry(userId, "in", "2026-08-10")).toBe(false);
      expect(pendingAttempt(userId, "in", "2026-08-10")).toBeUndefined();
      // Prove the brake that stopped it was the cutoff, not the cap.
      expect(0).toBeLessThan(currentPolicy().maxAttempts);
    });
  });

  describe("cancellation", () => {
    it("a manual run for the action cancels the pending retry", async () => {
      const { userId, cookie } = await userWithCredentials();
      const r0 = await insertFailedRun(userId, "in", 0, todayAtManila(5, 35));
      await scheduleRetryOnFailure(r0, todayAtManila(5, 35));
      await vi.waitFor(() => expect(hasPendingRetry(userId, "in", todayStr())).toBe(true));

      // "Clock in now" — the route, not a direct service call.
      const res = await request("/runs", {
        cookie,
        method: "POST",
        body: { action: "in" },
      });
      expect(res.status).toBe(202);
      await vi.waitFor(() => expect(hasPendingRetry(userId, "in", todayStr())).toBe(false));
    });

    it("a successful run for the same action cancels the pending retry", async () => {
      const { userId } = await userWithCredentials();
      const r0 = await insertFailedRun(userId, "in", 0, todayAtManila(5, 35));
      await scheduleRetryOnFailure(r0, todayAtManila(5, 35));
      await vi.waitFor(() => expect(hasPendingRetry(userId, "in", todayStr())).toBe(true));

      // A new run starts and succeeds: the retry is superseded at start.
      const manual = await startRun({ userId, action: "in" });
      expect(manual.ok).toBe(true);
      if (!manual.ok) return;
      vi.mocked(runAutomation).mockResolvedValue({
        success: true,
        skipped: false,
        loginMethod: "saved_session",
      });
      await executeQueuedRun(manual.run.id);

      expect(hasPendingRetry(userId, "in", todayStr())).toBe(false);
    });

    it("a pause set mid-morning cancels a queued retry", async () => {
      const { userId } = await userWithCredentials();
      await db.insert(schedules).values({ userId, enabled: true });
      const r0 = await insertFailedRun(userId, "in", 0, todayAtManila(5, 35));
      await scheduleRetryOnFailure(r0, todayAtManila(5, 35));
      await vi.waitFor(() => expect(hasPendingRetry(userId, "in", todayStr())).toBe(true));

      // Pause window covering today (set "mid-morning"): the queued retry must
      // not run.
      await db
        .update(schedules)
        .set({ pausedFrom: todayStr(), pausedUntil: todayStr() })
        .where(eq(schedules.userId, userId));
      const before = await db.$count(runs, eq(runs.userId, userId));

      await attemptRun(userId, "in", todayStr(), 1);

      expect(hasPendingRetry(userId, "in", todayStr())).toBe(false);
      expect(await db.$count(runs, eq(runs.userId, userId))).toBe(before);
    });

    it("a retry attempt on a holiday does not run", async () => {
      const { userId } = await userWithCredentials();
      // Control: without the override, today is a normal day — the retry runs.
      await attemptRun(userId, "in", todayStr(), 1);
      expect(await db.$count(runs, eq(runs.userId, userId))).toBe(1);
      clearPendingRetries();

      // With an operator override for today, the retry attempt is cancelled.
      process.env["EXTRA_HOLIDAYS"] = `${todayStr()}=Test Proclamation Day`;
      const { userId: user2 } = await userWithCredentials();
      await attemptRun(user2, "in", todayStr(), 1);
      expect(await db.$count(runs, eq(runs.userId, user2))).toBe(0);
      expect(hasPendingRetry(user2, "in", todayStr())).toBe(false);
    });
  });

  describe("the partial unique index", () => {
    it("a retry cannot collide with an active run: 23505 treated as already-handled, never a 500", async () => {
      const { userId } = await userWithCredentials();
      // A run is already pending for this user.
      const started = await startRun({ userId, action: "in" });
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      const before = await db.$count(runs, eq(runs.userId, userId));
      // The retry fires while the other run is still active.
      await expect(
        attemptRun(userId, "in", todayStr(), 1),
      ).resolves.toBeUndefined();

      // Exactly one active run survived; the retry did not add a second and did
      // not error out.
      expect(await db.$count(runs, eq(runs.userId, userId))).toBe(before);
      expect(hasPendingRetry(userId, "in", todayStr())).toBe(false);
      const [row] = await db
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.userId, userId))
        .limit(1);
      expect(["pending", "running"]).toContain(row?.status);
    });
  });

  describe("notification discipline (14B)", () => {
    it("the default explanation is said exactly once per user", async () => {
      const { userId } = await userWithCredentials();

      // First incident: the intro shows the defaults and the flag is set.
      const r0 = await insertFailedRun(userId, "in", 0, todayAtManila(5, 35));
      await scheduleRetryOnFailure(r0, todayAtManila(5, 35));
      await vi.waitFor(() => {
        expect(
          retryScheduledDispatches().some((html) => html.includes("Retrying every")),
        ).toBe(true);
      });
      const [u] = await db
        .select({ shown: users.retryIntroShown })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      expect(u?.shown).toBe(true);

      // Second incident (a fresh failure after the first retry was superseded):
      // no second mention of the defaults.
      clearPendingRetries();
      const r1 = await insertFailedRun(userId, "out", 0, todayAtManila(5, 35));
      await scheduleRetryOnFailure(r1, todayAtManila(5, 35));
      await vi.waitFor(() => {
        expect(hasPendingRetry(userId, "out", todayStr())).toBe(true);
      });

      const intros = retryScheduledDispatches().filter((html) =>
        html.includes("Retrying every"),
      );
      expect(intros.length).toBe(1);
    });

    it("no duplicate missed-run alert while a retry is pending", async () => {
      const { userId } = await userWithCredentials();
      await db.insert(schedules).values({
        userId,
        clockInTime: "05:30:00",
        clockOutTime: "18:05:00",
        enabled: true,
      });
      // A failed run from YESTERDAY (outside the sweep's 24h hasRunToday window)
      // is not the suppressant — only the pending retry can be.
      await db.insert(runs).values({
        userId,
        action: "in",
        status: "failure",
        attempt: 0,
        startedAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
      });
      const sent: string[] = [];
      const deps = {
        ...defaultSweepDeps,
        now: () => new Date("2026-08-10T06:10:00+08:00"),
        isWorkday: () => true,
        dispatchMissed: async (_uid: string, html: string) => {
          sent.push(html);
          return "sent" as const;
        },
      };

      // Control: without a pending retry the missed alert fires.
      await sweepMissedRuns(deps);
      expect(sent.length).toBe(1);

      // Now with a pending retry for the sweep's day: the sweep stays silent.
      sent.length = 0;
      await db
        .delete(missedRunNotices)
        .where(eq(missedRunNotices.userId, userId));
      await db
        .insert(missedRunNotices)
        .values({ userId, manilaDate: "2026-08-10", action: "in" });
      const fireAt = new Date(Date.now() + 30 * 60 * 1000);
      scheduleOneShotRetry({
        userId,
        action: "in",
        manilaDate: "2026-08-10",
        attempt: 1,
        fireAt,
        onFire: () => {},
      });
      await sweepMissedRuns(deps);
      expect(sent.length).toBe(0);
    });
  });

  describe("retry dispatch is fire-and-forget (rule 11)", () => {
    it("a dead Telegram endpoint does not change the run's terminal status or timing", async () => {
      process.env["TELEGRAM_API_BASE"] = "http://127.0.0.1:9";
      const { userId } = await userWithCredentials();
      await db.insert(notificationSettings).values({
        userId,
        telegramBotTokenEnc: encrypt(
          "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij", // gitleaks:allow
        ),
        telegramChatId: "123456789",
        enabled: true,
      });

      // Real flow: the run reaches failure on time despite the dead endpoint.
      const started = await startRun({ userId, action: "in" });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      const run = await lastRun(userId, "in", 0);
      if (!run) throw new Error("expected an attempt-0 run");
      const before = Date.now();
      vi.mocked(runAutomation).mockRejectedValue(new Error("boom"));
      await executeQueuedRun(run.id);

      const [finished] = await db
        .select({ status: runs.status, finishedAt: runs.finishedAt })
        .from(runs)
        .where(eq(runs.id, run.id))
        .limit(1);
      expect(finished?.status).toBe("failure");
      expect(finished?.finishedAt).not.toBeNull();
      expect(finished!.finishedAt!.getTime() - before).toBeLessThan(30_000);

      // The retry-scheduling path (with a morning anchor) must not throw either
      // — the dead endpoint cannot turn a failure into a 500. It schedules the
      // retry (return "retry") and the notification is fire-and-forget.
      const r0 = await insertFailedRun(userId, "out", 0, todayAtManila(5, 35));
      await expect(
        scheduleRetryOnFailure(r0, todayAtManila(5, 35)),
      ).resolves.toBe("retry");
      // Wait for the fire-and-forget send to finish its DB reads/writes so the
      // pool isn't closed under it by the afterAll hook.
      await vi.waitFor(() => {
        expect(
          (notificationsModule.dispatch as unknown as ReturnType<typeof vi.fn>)
            .mock.calls.length,
        ).toBeGreaterThan(0);
      });
      const [row] = await db
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.id, r0.id))
        .limit(1);
      expect(row?.status).toBe("failure");

      // The dead endpoint must not have incremented the blocked count.
      const [settings] = await db
        .select({ blockedCount: notificationSettings.blockedCount })
        .from(notificationSettings)
        .where(eq(notificationSettings.userId, userId))
        .limit(1);
      expect(settings?.blockedCount).toBe(0);
    });
  });
});

async function getRunRow(runId: string) {
  const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  return row;
}