import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "../../src/db/client";
import { runs, schedules, type Run } from "../../src/db/schema";
import { manilaDateString } from "../../src/services/workday";
import {
  cancelPendingRetriesForUser,
  failRunFromExecutor,
  finishRun,
  fireDueRetries,
  recoverOrphanedRuns,
  startRun,
  type LifecycleDeps,
} from "../../src/services/run-lifecycle";
import { findPendingRetry, hasPendingRetry } from "../../src/services/retry-state";
import { notifyRetryGiveUp } from "../../src/services/retry";
import {
  closeTestServer,
  createUser,
  request,
  resetDatabase,
  setupDatabase,
  startTestServer,
} from "./harness";

// Phase 15A — the Run lifecycle. Every trigger creates a run through one step
// and every ending goes through one terminal step that records the status, makes
// the retry decision, sends exactly one message and pings the heartbeat.
//
// The tests drive the module's INTERFACE — trigger in, status/retry state/
// message out — with the queue handoff and the terminal notification INJECTED,
// so no Chromium launches and no Telegram is contacted, while the database (the
// partial unique index, `runs.retry_at`) stays real.
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

type Recorded = {
  deps: Partial<LifecycleDeps>;
  terminal: { runId: string; status: string; skipReason: string | null }[];
  pings: () => number;
};

/** The lifecycle's collaborators, recorded instead of real. */
function recordingDeps(): Recorded {
  const terminal: Recorded["terminal"] = [];
  let pings = 0;
  return {
    terminal,
    pings: () => pings,
    deps: {
      enqueue: () => {
        /* the queue's executor is injected away: nothing runs */
      },
      notifyRunFinished: async (params) => {
        terminal.push({
          runId: params.run.id,
          status: params.run.status,
          skipReason: params.skipReason ?? null,
        });
        return "sent";
      },
      pingHeartbeat: () => {
        pings += 1;
      },
    },
  };
}

function dispatched(filter: string): string[] {
  return (
    notificationsModule.dispatch as unknown as ReturnType<typeof vi.fn>
  ).mock.calls
    .map((c) => c[1] as string)
    .filter((html) => typeof html === "string" && html.includes(filter));
}

async function userWithCredentials(): Promise<{ userId: string; cookie: string }> {
  const { user, cookie } = await createUser();
  await request("/credentials", {
    cookie,
    method: "PUT",
    body: { sproutUsername: "lifecycle-user", sproutPassword: "sprout-pass-1234" },
  });
  return { userId: user.id, cookie };
}

/** A failed run carrying a queued retry — the shape a restart leaves behind. */
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

describe("run lifecycle", () => {
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

  it("the EXECUTOR backstop ends the run through the terminal step: notified and a retry queued (path 4)", async () => {
    const { userId } = await userWithCredentials();
    const started = await startRun({ userId, action: "in" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const rec = recordingDeps();
    await failRunFromExecutor(started.run.id, new Error("executor threw"), {
      now: todayAtManila(5, 35),
      deps: rec.deps,
    });

    const [row] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, started.run.id))
      .limit(1);
    expect(row?.status).toBe("failure");
    expect(row?.error).toBe("executor threw");
    expect(row?.finishedAt).not.toBeNull();

    // NEW in 15A: the backstop used to write `failure` and notify, but never
    // scheduled a retry. It now goes through the same terminal step.
    expect(await hasPendingRetry(userId, "in", todayStr())).toBe(true);
    const pending = await findPendingRetry(userId, "in", todayStr());
    expect(pending?.retryAt.getTime()).toBe(todayAtManila(6, 5).getTime());

    // The retry message REPLACES the standard ⚠️ (14B discipline), and the slot
    // has not reached its outcome, so no heartbeat.
    expect(rec.terminal).toHaveLength(0);
    expect(rec.pings()).toBe(0);
    await vi.waitFor(() => {
      expect(dispatched("will retry").length).toBe(1);
    });
  });

  it("orphan recovery notifies and queues a retry when one is still possible (path 1)", async () => {
    const { userId } = await userWithCredentials();
    await db.insert(runs).values({
      userId,
      action: "in",
      status: "running",
      startedAt: todayAtManila(5, 30),
    });

    const rec = recordingDeps();
    const recovered = await recoverOrphanedRuns({
      now: todayAtManila(5, 31),
      deps: rec.deps,
    });
    expect(recovered).toBe(1);

    const [row] = await db
      .select()
      .from(runs)
      .where(and(eq(runs.userId, userId), eq(runs.action, "in")))
      .limit(1);
    expect(row?.status).toBe("failure");
    expect(row?.error).toBe("Interrupted by server restart");

    // Once interrupted, the retry is scheduled from the restart instant.
    const pending = await findPendingRetry(userId, "in", todayStr());
    expect(pending?.attempt).toBe(1);
    expect(pending?.retryAt.getTime()).toBe(todayAtManila(6, 1).getTime());
    expect(rec.terminal).toHaveLength(0);
    await vi.waitFor(() => {
      expect(dispatched("will retry").length).toBe(1);
    });
  });

  it("orphan recovery past the cutoff sends the give-up message instead of a retry (path 1)", async () => {
    const { userId } = await userWithCredentials();
    await db.insert(runs).values({
      userId,
      action: "in",
      status: "running",
      startedAt: todayAtManila(5, 30),
    });

    const rec = recordingDeps();
    const recovered = await recoverOrphanedRuns({
      now: todayAtManila(13, 0), // past the 12:00 clock-in cutoff
      deps: rec.deps,
    });
    expect(recovered).toBe(1);

    expect(await hasPendingRetry(userId, "in", todayStr())).toBe(false);
    // The interruption is reported, not swallowed, and carries the reason.
    await vi.waitFor(() => {
      expect(dispatched("gave up").length).toBe(1);
    });
    expect(dispatched("gave up")[0]).toContain("Interrupted by server restart");
    // A terminal outcome: the heartbeat pings.
    expect(rec.pings()).toBe(1);
  });

  it("a retry attempt that ERRORS is not left queued, so the day stops being suppressed (path 3)", async () => {
    const { userId } = await userWithCredentials();
    await db.insert(schedules).values({
      userId,
      clockInTime: "05:30:00",
      clockOutTime: "18:05:00",
      enabled: true,
    });
    const failed = await queueRetry(
      userId,
      "in",
      0,
      todayAtManila(5, 35),
      todayAtManila(6, 5),
    );

    // The insert fails with a non-unique database error — the case whose outer
    // catch used to return without cancelling, leaving the entry "pending"
    // forever.
    await fireDueRetries(todayAtManila(6, 5), {
      createRun: async () => {
        throw new Error("database exploded");
      },
    });

    // The claim happens BEFORE the attempt runs, so a failure cannot leave the
    // retry queued: `retry_at` is NULL and the sweep's suppression probe answers
    // "nothing pending" again.
    const [row] = await db
      .select({ retryAt: runs.retryAt })
      .from(runs)
      .where(eq(runs.id, failed.id))
      .limit(1);
    expect(row?.retryAt).toBeNull();
    expect(await hasPendingRetry(userId, "in", todayStr())).toBe(false);
  });

  it("a due retry goes through the ONE creation path: no credentials means no run", async () => {
    // The old retry path inserted its own row, skipping the credentials check.
    const { user } = await createUser();
    await queueRetry(user.id, "in", 0, todayAtManila(5, 35), todayAtManila(6, 5));

    await fireDueRetries(todayAtManila(6, 5));

    // Only the original failed row exists — no second attempt was created.
    expect(await db.$count(runs, eq(runs.userId, user.id))).toBe(1);
    expect(await hasPendingRetry(user.id, "in", todayStr())).toBe(false);
  });

  it("a manual click while a retry is queued supersedes it, through the one path", async () => {
    const { userId, cookie } = await userWithCredentials();
    await queueRetry(userId, "in", 0, todayAtManila(5, 35), todayAtManila(6, 5));
    expect(await hasPendingRetry(userId, "in", todayStr())).toBe(true);

    const res = await request("/runs", {
      cookie,
      method: "POST",
      body: { action: "in" },
    });
    expect(res.status).toBe(202);
    expect(await hasPendingRetry(userId, "in", todayStr())).toBe(false);
  });

  it("cancelPendingRetriesForUser clears the queue without touching run history", async () => {
    const { userId } = await userWithCredentials();
    const row = await queueRetry(
      userId,
      "in",
      0,
      todayAtManila(5, 35),
      todayAtManila(6, 5),
    );

    expect(await cancelPendingRetriesForUser(userId)).toBe(1);

    const [after] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, row.id))
      .limit(1);
    expect(after?.retryAt).toBeNull();
    expect(after?.status).toBe("failure");
  });

  it("deleting an account leaves no queued retry", async () => {
    const { userId, cookie } = await userWithCredentials();
    await queueRetry(userId, "in", 0, todayAtManila(5, 35), todayAtManila(6, 5));
    expect(await hasPendingRetry(userId, "in", todayStr())).toBe(true);

    const res = await request("/auth/account", {
      cookie,
      method: "DELETE",
      body: { password: "integration-pass-1234" }, // gitleaks:allow
    });
    expect(res.status).toBe(200);

    const remaining = await db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.userId, userId), isNotNull(runs.retryAt)));
    expect(remaining).toHaveLength(0);
  });
  // Found in a sandbox run 2026-10-15: the evening heads-up went out beside
  // "Clock-out failed — will retry", before the clock-out had an outcome.
  it("the heads-up waits for a clock-out OUTCOME: not on a failure with a retry queued, yes on a give-up or success", async () => {
    const { userId } = await userWithCredentials();
    const headsUps: string[] = [];
    const rec = recordingDeps();
    const deps: Partial<LifecycleDeps> = {
      ...rec.deps,
      notifyHeadsUp: async (params) => {
        headsUps.push(params.userId);
        return "sent";
      },
    };

    const first = await startRun({ userId, action: "out" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const failed = await finishRun(
      { run: first.run, status: "failure", error: "boom: HRHub unreachable" },
      { now: todayAtManila(16, 16), deps },
    );
    expect(failed.retry).toBe("retry");
    expect(headsUps).toHaveLength(0);

    await cancelPendingRetriesForUser(userId);
    const second = await startRun({ userId, action: "out" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    await finishRun({ run: second.run, status: "success" }, { now: todayAtManila(16, 47), deps });
    expect(headsUps).toEqual([userId]);
  });

  it("the give-up message counts every failed attempt, not just the retries", async () => {
    const { userId } = await userWithCredentials();
    await notifyRetryGiveUp({ userId, action: "in", attempt: 2, error: "boom" });
    await notifyRetryGiveUp({ userId, action: "out", attempt: 0, error: "boom" });
    expect(dispatched("gave up")[0]).toContain("Clock-in failed 3 times and gave up");
    expect(dispatched("gave up")[1]).toContain("Clock-out failed and gave up");
  });
});
