import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client";
import { runs } from "../../src/db/schema";
import { executeQueuedRun, startRun } from "../../src/services/runs";
import { runAutomation } from "../../src/automation/runAutomation";
import {
  closeTestServer,
  createUser,
  request,
  resetDatabase,
  setupDatabase,
  startTestServer,
} from "./harness";

// Phase 14 wiring proof: every terminal-state writer goes through finalizeRun,
// and finalizeRun must invoke scheduleRetryOnFailure on a FAILURE exactly once
// and never on a skipped or successful run. The retry module is mocked here so
// the call is observable in isolation from its own behaviour (which the
// retry.test.ts suite covers). Deterministic at any wall-clock time.
vi.mock("../../src/services/retry", () => ({
  scheduleRetryOnFailure: vi.fn().mockResolvedValue("retry" as const),
}));
vi.mock("../../src/automation/runAutomation", () => ({
  runAutomation: vi.fn(),
}));
import { scheduleRetryOnFailure } from "../../src/services/retry";

describe("retry wiring: finalizeRun -> scheduleRetryOnFailure", () => {
  beforeAll(async () => {
    await setupDatabase();
    await startTestServer();
  });
  beforeEach(async () => {
    await resetDatabase();
    vi.mocked(scheduleRetryOnFailure).mockClear();
  });
  afterAll(async () => {
    await closeTestServer();
  });

  async function failedRunFor(userId: string): Promise<string> {
    const started = await startRun({ userId, action: "in" });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("expected startRun to succeed");
    const [run] = await db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.userId, userId))
      .limit(1);
    if (!run) throw new Error("expected a run row");
    return run.id;
  }

  it("a failure calls scheduleRetryOnFailure exactly once, with the failed run", async () => {
    const { user, cookie } = await createUser();
    await request("/credentials", {
      cookie,
      method: "PUT",
      body: { sproutUsername: "wiring-user", sproutPassword: "sprout-pass-1234" },
    });
    const runId = await failedRunFor(user.id);
    vi.mocked(runAutomation).mockRejectedValue(new Error("boom"));
    await executeQueuedRun(runId);

    expect(scheduleRetryOnFailure).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(scheduleRetryOnFailure).mock.calls[0]?.[0];
    expect(arg?.status).toBe("failure");
    expect(arg?.userId).toBe(user.id);
    expect(arg?.action).toBe("in");
  });

  it("a skipped run never calls scheduleRetryOnFailure", async () => {
    const { user, cookie } = await createUser();
    await request("/credentials", {
      cookie,
      method: "PUT",
      body: { sproutUsername: "wiring-user", sproutPassword: "sprout-pass-1234" },
    });
    const runId = await failedRunFor(user.id);
    vi.mocked(runAutomation).mockResolvedValue({
      success: true,
      skipped: true,
      loginMethod: "saved_session",
      skipReason: "already clocked in",
    });
    await executeQueuedRun(runId);

    expect(scheduleRetryOnFailure).not.toHaveBeenCalled();
  });

  it("a successful run never calls scheduleRetryOnFailure", async () => {
    const { user, cookie } = await createUser();
    await request("/credentials", {
      cookie,
      method: "PUT",
      body: { sproutUsername: "wiring-user", sproutPassword: "sprout-pass-1234" },
    });
    const runId = await failedRunFor(user.id);
    vi.mocked(runAutomation).mockResolvedValue({
      success: true,
      skipped: false,
      loginMethod: "saved_session",
    });
    await executeQueuedRun(runId);

    expect(scheduleRetryOnFailure).not.toHaveBeenCalled();
  });
});