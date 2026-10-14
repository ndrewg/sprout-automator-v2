import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { and, eq } from "drizzle-orm";
import { db, pool } from "../../src/db/client";
import { credentials, runs, schedules, type Run } from "../../src/db/schema";
import { manilaDateString } from "../../src/lib/ph-holidays";
import { registerRetryTick, fireDueRetries } from "../../src/services/run-lifecycle";
import {
  claimRetry,
  clearPendingRetry,
  findPendingRetry,
  hasPendingRetry,
} from "../../src/services/retry-state";
import { defaultSweepDeps, sweepMissedRuns } from "../../src/services/notifications";
import { stopWallClockTick } from "../../src/lib/wall-clock-tick";
import {
  closeTestServer,
  createUser,
  request,
  resetDatabase,
  setupDatabase,
  startTestServer,
} from "./harness";

// Phase 15B — retry state survives a restart.
//
// The queued retry used to live in an in-memory Map (services/retry-registry.ts)
// and a restart threw it away: the user was told "will retry at 06:05" and then
// heard nothing — no attempt, no give-up, and no missed-run alert, because the
// sweep's "a retry is pending" probe read the same dead Map. It is now
// `runs.retry_at`, read from the database by the tick and claimed atomically.
//
// "A restart" here means what the process actually does: the wall-clock tick's
// handlers are gone, the retry tick is re-registered, and the database is
// untouched.
vi.mock("../../src/services/notifications", async (importOriginal) => {
  const mod =
    await importOriginal<typeof import("../../src/services/notifications")>();
  return { ...mod, dispatch: vi.fn(mod.dispatch) };
});
import * as notificationsModule from "../../src/services/notifications";

const todayStr = (): string => manilaDateString(new Date());

/** The instant whose Manila wall clock is TODAY at hour:minute. */
function todayAtManila(hour: number, minute: number): Date {
  const manilaDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [y, m, d] = manilaDate.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, hour - 8, minute));
}

/** A failed run carrying a queued retry — what a restart finds on disk. */
async function queueRetry(
  userId: string,
  action: "in" | "out",
  attempt: number,
  failedAt: Date,
  due: Date,
): Promise<Run> {
  const [row] = await db
    .insert(runs)
    .values({
      userId,
      action,
      status: "failure",
      attempt,
      error: "boom: HRHub unreachable",
      startedAt: failedAt,
      finishedAt: failedAt,
      retryAt: due,
    })
    .returning();
  if (!row) throw new Error("queueRetry: insert returned no row");
  return row;
}

async function userWithCredentials(): Promise<{ userId: string; cookie: string }> {
  const { user, cookie } = await createUser();
  await request("/credentials", {
    cookie,
    method: "PUT",
    body: { sproutUsername: "durable-user", sproutPassword: "sprout-pass-1234" },
  });
  return { userId: user.id, cookie };
}

/** A process restart, as far as this feature is concerned: no tick handlers and
 *  no in-memory retry state (there is none any more) — the database is all that
 *  is left. */
function simulateRestart(): void {
  stopWallClockTick();
  registerRetryTick();
}

function giveUps(): string[] {
  return (
    notificationsModule.dispatch as unknown as ReturnType<typeof vi.fn>
  ).mock.calls
    .map((c) => c[1] as string)
    .filter((html) => typeof html === "string" && html.includes("gave up"));
}

describe("durable retries (runs.retry_at)", () => {
  beforeAll(async () => {
    await setupDatabase();
    await startTestServer();
  });
  beforeEach(async () => {
    await resetDatabase();
    (
      notificationsModule.dispatch as unknown as ReturnType<typeof vi.fn>
    ).mockClear();
  });
  afterAll(async () => {
    await closeTestServer();
  });

  it("a queued retry survives a restart and fires at its time", async () => {
    const { userId } = await userWithCredentials();
    await queueRetry(userId, "in", 0, todayAtManila(5, 35), todayAtManila(6, 5));

    // "Pending" is a database read now, with nothing in memory.
    expect(await hasPendingRetry(userId, "in", todayStr())).toBe(true);
    expect((await findPendingRetry(userId, "in", todayStr()))?.attempt).toBe(1);

    simulateRestart();

    // Still pending on the other side of the restart.
    expect(await hasPendingRetry(userId, "in", todayStr())).toBe(true);

    // The tick fires it at its time: a fresh attempt-1 run exists.
    await fireDueRetries(todayAtManila(6, 5));
    const attempts = await db
      .select({ attempt: runs.attempt, status: runs.status })
      .from(runs)
      .where(and(eq(runs.userId, userId), eq(runs.action, "in")));
    expect(attempts.map((r) => r.attempt).sort((a, b) => a - b)).toEqual([0, 1]);
    expect(attempts.find((r) => r.attempt === 1)?.status).toBe("pending");
    // The retry was claimed, so it cannot fire twice.
    expect(await hasPendingRetry(userId, "in", todayStr())).toBe(false);
  });

  it("a restored retry past its cutoff is discarded with a give-up message, never fired", async () => {
    const { userId } = await userWithCredentials();
    // A clock-out queued for 22:50 that the process never got to fire, restored
    // at 23:30 — past the 23:00 wall-clock cutoff.
    await queueRetry(userId, "out", 0, todayAtManila(22, 20), todayAtManila(22, 50));

    simulateRestart();
    await fireDueRetries(todayAtManila(23, 30));

    // No 23:30 clock-out on the record, and the user is told rather than left
    // waiting for an attempt that will not come.
    expect(await db.$count(runs, eq(runs.userId, userId))).toBe(1);
    expect(await hasPendingRetry(userId, "out", todayStr())).toBe(false);
    await vi.waitFor(() => {
      expect(giveUps().length).toBe(1);
    });
    expect(giveUps()[0]).toContain("Clock-out failed and gave up");
  });

  it("a restored retry re-applies the attempt cap", async () => {
    const { userId } = await userWithCredentials();
    // attempt 3 == RETRY_MAX_ATTEMPTS with a retry still queued (a config change
    // between runs is the realistic cause).
    await queueRetry(userId, "in", 3, todayAtManila(5, 35), todayAtManila(6, 5));

    await fireDueRetries(todayAtManila(6, 5));

    expect(await db.$count(runs, eq(runs.userId, userId))).toBe(1);
    await vi.waitFor(() => {
      expect(giveUps().length).toBe(1);
    });
  });

  it("a restored retry re-applies the pause window", async () => {
    const { userId } = await userWithCredentials();
    await db.insert(schedules).values({ userId, enabled: true });
    await queueRetry(userId, "in", 0, todayAtManila(5, 35), todayAtManila(6, 5));
    await db
      .update(schedules)
      .set({ pausedFrom: todayStr(), pausedUntil: todayStr() })
      .where(eq(schedules.userId, userId));

    await fireDueRetries(todayAtManila(6, 5));

    expect(await db.$count(runs, eq(runs.userId, userId))).toBe(1);
    expect(await hasPendingRetry(userId, "in", todayStr())).toBe(false);
  });

  it("a restored retry re-applies the holiday check", async () => {
    const { userId } = await userWithCredentials();
    await queueRetry(userId, "in", 0, todayAtManila(5, 35), todayAtManila(6, 5));
    process.env["EXTRA_HOLIDAYS"] = `${todayStr()}=Test Proclamation Day`;

    try {
      await fireDueRetries(todayAtManila(6, 5));
    } finally {
      delete process.env["EXTRA_HOLIDAYS"];
    }

    expect(await db.$count(runs, eq(runs.userId, userId))).toBe(1);
    expect(await hasPendingRetry(userId, "in", todayStr())).toBe(false);
  });

  it("the missed-run alert stays suppressed while a retry is queued, across the restart", async () => {
    const { userId } = await userWithCredentials();
    await db.insert(schedules).values({
      userId,
      clockInTime: "05:30:00",
      clockOutTime: "18:05:00",
      enabled: true,
    });
    // A retry queued for TODAY on a run that is NOT inside the sweep's 24-hour
    // "did a run happen today" window, so the retry queue is the only thing that
    // can keep the sweep quiet. Constructed directly on purpose: when the sweep
    // runs for a slot's own day, the day's own failed run already suppresses it
    // — this asserts the belt-and-braces probe the phase requires.
    await db.insert(runs).values({
      userId,
      action: "in",
      status: "failure",
      attempt: 0,
      error: "boom: HRHub unreachable",
      startedAt: new Date(Date.now() - 50 * 60 * 60 * 1000),
      retryAt: todayAtManila(6, 5),
    });

    const sent: string[] = [];
    const deps = {
      ...defaultSweepDeps,
      now: () => todayAtManila(6, 30),
      isWorkday: () => true,
      dispatchMissed: async (_uid: string, html: string) => {
        sent.push(html);
        return "sent" as const;
      },
    };

    simulateRestart();
    await sweepMissedRuns(deps);
    expect(sent).toHaveLength(0);

    // Cancel the retry (as a successful manual run would) and the alert returns.
    await clearPendingRetry(userId, "in", todayStr());
    await sweepMissedRuns(deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Missed the 05:30 clock-in");
  });

  it("a retry cancelled before the restart does not come back", async () => {
    const { userId } = await userWithCredentials();
    await queueRetry(userId, "in", 0, todayAtManila(5, 35), todayAtManila(6, 5));
    await clearPendingRetry(userId, "in", todayStr()); // e.g. the user clicked

    simulateRestart();

    expect(await hasPendingRetry(userId, "in", todayStr())).toBe(false);
    await fireDueRetries(todayAtManila(6, 5));
    expect(await db.$count(runs, eq(runs.userId, userId))).toBe(1);
  });

  it("two concurrent claims of the same due retry produce exactly one run", async () => {
    const { userId } = await userWithCredentials();
    await queueRetry(userId, "in", 0, todayAtManila(5, 35), todayAtManila(6, 5));

    // Two ticks (or a restarted process racing the old one) both see the row.
    await Promise.all([
      fireDueRetries(todayAtManila(6, 5)),
      fireDueRetries(todayAtManila(6, 5)),
    ]);

    expect(
      await db.$count(runs, and(eq(runs.userId, userId), eq(runs.attempt, 1))),
    ).toBe(1);
  });

  it("two ticks racing the same due retry send exactly one give-up", async () => {
    const { userId } = await userWithCredentials();
    // A clock-out queued for 22:50, DUE (22:50 <= 23:30) but past the 23:00
    // wall-clock cutoff, so a claimant that wins the claim reaches
    // `fireClaimedRetry`'s DISCARD path. That is where the atomic claim is
    // actually observable: unlike the test above, `runs_one_active_per_user`
    // cannot mask a double-claim here, because the discard path sends a message
    // and never inserts a run — a non-atomic claim lets BOTH ticks dispatch a 🛑.
    const failed = await queueRetry(
      userId,
      "out",
      0,
      todayAtManila(22, 20),
      todayAtManila(22, 50),
    );
    const fireAt = todayAtManila(23, 30);

    // Two plainly-timed ticks do NOT exercise this: pg's pool serves the first
    // tick's claim before the second tick's SELECT, so the second reads
    // `retry_at` already null and never claims (measured: only one tick ever
    // reaches the claim). Holding the failed row with `SELECT … FOR UPDATE`
    // makes the first claim BLOCK — its WHERE can only be evaluated once we
    // commit — while the second tick still reads `retry_at` as non-null, so both
    // ticks genuinely reach the claim. Release the lock and the atomic UPDATE
    // decides the winner.
    const locker = await pool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT id FROM runs WHERE id = $1 FOR UPDATE", [
        failed.id,
      ]);
      const ticks = Promise.all([
        fireDueRetries(fireAt),
        fireDueRetries(fireAt),
      ]);
      // Both ticks have loaded the row and issued their (blocked) claims.
      await new Promise((resolve) => setTimeout(resolve, 250));
      await locker.query("COMMIT");
      await ticks;
    } finally {
      locker.release();
    }

    // One claimant wins; the loser's `claimRetry` returns undefined (`retry_at`
    // is already null) and it is skipped, so exactly ONE give-up is dispatched —
    // a second would double-message the user about the same morning.
    await vi.waitFor(() => {
      expect(giveUps().length).toBe(1);
    });
    expect(giveUps()[0]).toContain("Clock-out failed and gave up");
    // No run was created by either claimant; the failed attempt-0 row is all.
    expect(await db.$count(runs, eq(runs.userId, userId))).toBe(1);
  });

  it("claimRetry is atomic: a second claim of the same row gets nothing", async () => {
    const { userId } = await userWithCredentials();
    const failed = await queueRetry(
      userId,
      "out",
      0,
      todayAtManila(22, 20),
      todayAtManila(22, 50),
    );

    // The claim IS its WHERE clause: only a caller that still sees `retry_at`
    // non-null may take the row, so a second claimant gets nothing. Dropping the
    // `retry_at IS NOT NULL` guard lets every caller through.
    const [first, second] = await Promise.all([
      claimRetry(failed.id),
      claimRetry(failed.id),
    ]);
    expect([first, second].filter((r) => r !== undefined)).toHaveLength(1);
    // A later tick (e.g. after a restart) also gets nothing.
    expect(await claimRetry(failed.id)).toBeUndefined();
  });

  it("a claimed retry whose credentials have gone sends exactly one give-up", async () => {
    const { userId } = await userWithCredentials();
    await queueRetry(userId, "in", 0, todayAtManila(5, 35), todayAtManila(6, 5));

    // The credentials vanish between the failure and the retry. The user was
    // told "will retry at 06:05"; the retry is then claimed and refused. No run
    // is created, and — because the day's own failed run row makes the sweep's
    // `hasRunToday` true — no missed-run alert covers it either. Silence would
    // leave the promise dangling, so a give-up must be sent.
    await db.delete(credentials).where(eq(credentials.userId, userId));

    await fireDueRetries(todayAtManila(6, 5));

    await vi.waitFor(() => {
      expect(giveUps().length).toBe(1);
    });
    expect(giveUps()[0]).toContain("Clock-in failed and gave up");
    // The attempt-1 run was never created.
    expect(await db.$count(runs, eq(runs.userId, userId))).toBe(1);
    expect(await hasPendingRetry(userId, "in", todayStr())).toBe(false);
  });
});
