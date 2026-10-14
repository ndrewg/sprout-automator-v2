import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client";
import { notificationSettings, runs } from "../../src/db/schema";
import { encrypt } from "../../src/lib/encryption";
import { NO_CLOCK_IN_SKIP_REASON, unknownOutcomeDetail } from "../../src/lib/run-outcome";
import { startRun } from "../../src/services/run-lifecycle";
import { executeQueuedRun } from "../../src/services/runs";
import { runAutomation } from "../../src/automation/runAutomation";
import {
  closeTestServer,
  createUser,
  request,
  resetDatabase,
  setupDatabase,
  startTestServer,
} from "./harness";

// Phase 17 § 17B — the attempt's conclusion, end to end through the executor, the
// run lifecycle and the notifier.
//
// The automation is mocked (no Chromium, no HRHub) and the Telegram transport is
// mocked (no network), so what is under test is the WIRING: what an attempt's
// outcome becomes in the database, whether a retry is scheduled, and what the
// user is actually told. The transport is the right seam for the message
// assertions because `dispatch` is usually called from inside notifications.ts
// itself, where a module mock of `dispatch` would not be seen.
//
// The retry decision is mocked too, deliberately: the real one refuses a
// clock-in retry after the 12:00 Manila cutoff, so a test on the real decision
// would pass or fail by the hour the suite happens to run.
vi.mock("../../src/services/retry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/retry")>()),
  scheduleRetryOnFailure: vi.fn().mockResolvedValue("retry" as const),
}));
vi.mock("../../src/automation/runAutomation", () => ({
  runAutomation: vi.fn(),
}));
vi.mock("../../src/lib/telegram", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/lib/telegram")>();
  return { ...mod, sendTelegramMessage: vi.fn().mockResolvedValue({ ok: true }) };
});
import { scheduleRetryOnFailure } from "../../src/services/retry";
import { sendTelegramMessage } from "../../src/lib/telegram";

/** The HTML handed to the transport, in order. */
function sentMessages(): string[] {
  return vi.mocked(sendTelegramMessage).mock.calls.map((call) => call[2]);
}

function sentContaining(fragment: string): string[] {
  return sentMessages().filter((html) => html.includes(fragment));
}

async function enqueueRun(
  action: "in" | "out",
): Promise<{ runId: string; userId: string }> {
  const { user, cookie } = await createUser();
  await request("/credentials", {
    cookie,
    method: "PUT",
    body: { sproutUsername: "unknown-outcome-user", sproutPassword: "sprout-pass-1234" },
  });
  // Notifications configured and enabled, so the outcome message is dispatched
  // for real and lands on the mocked transport.
  await db.insert(notificationSettings).values({
    userId: user.id,
    telegramBotTokenEnc: encrypt(
      "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij", // gitleaks:allow
    ),
    telegramChatId: "123456789",
    enabled: true,
  });
  const started = await startRun({ userId: user.id, action });
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error("expected startRun to succeed");
  return { runId: started.run.id, userId: user.id };
}

async function runRow(runId: string) {
  const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (!row) throw new Error("expected a run row");
  return row;
}

describe("clock attempt outcomes in the run lifecycle", () => {
  beforeAll(async () => {
    await setupDatabase();
    await startTestServer();
  });
  beforeEach(async () => {
    await resetDatabase();
    vi.mocked(scheduleRetryOnFailure).mockClear();
    vi.mocked(sendTelegramMessage).mockClear();
  });
  afterAll(async () => {
    await closeTestServer();
  });

  it("stores 'unknown' as failure + outcome, schedules NO retry, and alerts (phase 17 rule 4)", async () => {
    const { runId } = await enqueueRun("in");
    vi.mocked(runAutomation).mockResolvedValue({
      outcome: "unknown",
      loginMethod: "saved_session",
      error: unknownOutcomeDetail(),
    });

    await executeQueuedRun(runId);

    const row = await runRow(runId);
    // The status enum and the partial unique index are untouched: an unknown is
    // a failure, with a machine-readable outcome beside it.
    expect(row.status).toBe("failure");
    expect(row.outcome).toBe("unknown");
    expect(row.error).toBe(unknownOutcomeDetail());
    expect(row.retryAt).toBeNull();

    // The decision that protects the day: NOTHING was scheduled. A retry here
    // could put a second record on a day whose state we could not confirm.
    expect(scheduleRetryOnFailure).not.toHaveBeenCalled();

    // And the user is told, with the message that says to check HRHub first.
    await vi.waitFor(() => {
      expect(sentContaining("state unknown").length).toBe(1);
    });
    const alert = sentContaining("state unknown")[0] ?? "";
    expect(alert).toContain("Clock-in state unknown");
    expect(alert).toContain("before clocking manually");
    expect(alert).not.toContain("Clock-in failed");
  });

  it("still retries a failure that happened BEFORE the click (unchanged phase-14 behaviour)", async () => {
    const { runId } = await enqueueRun("in");
    vi.mocked(runAutomation).mockResolvedValue({
      outcome: "failure",
      loginMethod: "saved_session",
      error: "Neither .dsk-btn nor .mbl-btn found in .clock-in-out-dropdown",
    });

    await executeQueuedRun(runId);

    const row = await runRow(runId);
    expect(row.status).toBe("failure");
    // No outcome: only "unknown" is ever stored, so the column cannot mean two
    // things at once.
    expect(row.outcome).toBeNull();
    expect(scheduleRetryOnFailure).toHaveBeenCalledTimes(1);
  });

  it("a skip stays a skip, with no outcome and no retry", async () => {
    const { runId } = await enqueueRun("in");
    vi.mocked(runAutomation).mockResolvedValue({
      outcome: "skipped",
      loginMethod: "saved_session",
      skipReason: 'Already clocked IN today (matched row "08/10/26\tIN\t05:02 AM") — skipping.',
    });

    await executeQueuedRun(runId);

    const row = await runRow(runId);
    expect(row.status).toBe("skipped");
    expect(row.outcome).toBeNull();
    expect(scheduleRetryOnFailure).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(sentContaining("Clock-in skipped").length).toBe(1);
    });
  });

  it("a clock-out abandoned for want of a clock-in alerts the user", async () => {
    const { runId } = await enqueueRun("out");
    vi.mocked(runAutomation).mockResolvedValue({
      outcome: "skipped",
      loginMethod: "saved_session",
      skipReason: NO_CLOCK_IN_SKIP_REASON,
    });

    await executeQueuedRun(runId);

    const row = await runRow(runId);
    expect(row.status).toBe("skipped");
    await vi.waitFor(() => {
      expect(sentContaining("no clock-in today").length).toBe(1);
    });
    const alert = sentContaining("no clock-in today")[0] ?? "";
    expect(alert).toContain("Clock-out skipped — no clock-in today");
    expect(alert).toContain("Nothing was clocked out.");
  });
});
