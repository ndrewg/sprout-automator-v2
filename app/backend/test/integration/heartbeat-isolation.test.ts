import { createServer, type Server } from "node:http";
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
import { runs } from "../../src/db/schema";
import { executeQueuedRun } from "../../src/services/runs";
import { fireCron } from "../../src/services/scheduler";
import { finishRun, startRun } from "../../src/services/run-lifecycle";
import { clearPendingRetry } from "../../src/services/retry-state";
import { manilaDateString } from "../../src/services/workday";
import { runAutomation } from "../../src/automation/runAutomation";
import {
  closeTestServer,
  createUser,
  request,
  resetDatabase,
  setupDatabase,
  startTestServer,
} from "./harness";

// 12D + 15A — the dead-man's-switch heartbeat. Two properties:
//
//  1. It can NEVER affect a run (hard rule 11, the same property
//     notification-isolation proves for Telegram): a rejecting or hanging
//     endpoint must not fail, delay or alter a scheduler fire or a run's
//     terminal step.
//  2. Since phase 15A it pings on an OUTCOME — a run that succeeded, was
//     deliberately skipped, or gave up — not on the tick. An outside monitor
//     then means "today's slot was handled" rather than "the process was
//     awake", which is the difference between a useful alarm and a useless one.
//     A failure that still has a retry queued is NOT an outcome, and must not
//     ping.

vi.mock("../../src/automation/runAutomation", () => ({
  runAutomation: vi.fn(),
}));

// A known weekday that is not a Philippine holiday.
const WORKDAY = new Date("2026-08-11T01:00:00Z");
// Christmas Day — a library `public` holiday, so fireCron takes the skip path.
const HOLIDAY = new Date("2026-12-25T04:00:00Z");

describe("heartbeat never affects runs", () => {
  let mock: Server | null = null;
  let pings: string[] = [];

  beforeAll(async () => {
    await setupDatabase();
    await startTestServer();
  });
  beforeEach(async () => {
    await resetDatabase();
    delete process.env["HEARTBEAT_URL"];
    vi.mocked(runAutomation).mockReset();
    pings = [];
  });
  afterAll(async () => {
    if (mock) await new Promise((r) => mock!.close(r));
    delete process.env["HEARTBEAT_URL"];
    await closeTestServer();
  });

  async function userWithCredentials(): Promise<{ id: string }> {
    const { user, cookie } = await createUser();
    await request("/credentials", {
      cookie,
      method: "PUT",
      body: { sproutUsername: "hb-user", sproutPassword: "hb-pass-1234" },
    });
    return user;
  }

  it("a rejecting heartbeat endpoint does not fail or delay a scheduler fire, and the run proceeds", async () => {
    // Nothing listens on this port: the ping rejects immediately.
    process.env["HEARTBEAT_URL"] = "http://127.0.0.1:9";

    const user = await userWithCredentials();

    const start = Date.now();
    await fireCron(user.id, "in", WORKDAY); // must resolve promptly, not hang
    const elapsed = Date.now() - start;

    // The dead heartbeat must not delay the fire (its timeout is 5s; a hang
    // would make this far larger).
    expect(elapsed).toBeLessThan(1000);

    // The fire proceeded normally: a run row was enqueued.
    const [run] = await db
      .select()
      .from(runs)
      .where(eq(runs.userId, user.id))
      .limit(1);
    expect(run).toBeDefined();
    expect(run?.status).toBe("pending");
  });

  it("a hanging heartbeat endpoint does not delay a scheduler fire", async () => {
    // A local server that accepts the connection but never responds.
    mock = createServer((_req, _res) => {
      /* never respond */
    });
    await new Promise<void>((resolve) => mock!.listen(0, resolve));
    const addr = mock.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    process.env["HEARTBEAT_URL"] = `http://127.0.0.1:${port}/never`;

    const user = await userWithCredentials();

    const start = Date.now();
    await fireCron(user.id, "in", WORKDAY);
    const elapsed = Date.now() - start;
    // AbortSignal.timeout(5000) would otherwise wait the full 5s; the fire must
    // not wait on it.
    expect(elapsed).toBeLessThan(1000);

    const [run] = await db
      .select()
      .from(runs)
      .where(eq(runs.userId, user.id))
      .limit(1);
    expect(run).toBeDefined();
  });

  it("a dead endpoint does not delay a run's terminal step, and the run still ends", async () => {
    process.env["HEARTBEAT_URL"] = "http://127.0.0.1:9";
    const user = await userWithCredentials();
    const started = await startRun({ userId: user.id, action: "in" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const before = Date.now();
    vi.mocked(runAutomation).mockRejectedValue(new Error("boom"));
    await executeQueuedRun(started.run.id);
    const elapsed = Date.now() - before;

    expect(elapsed).toBeLessThan(5000);
    const [row] = await db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, started.run.id))
      .limit(1);
    expect(row?.status).toBe("failure");
  });

  it("pings exactly once when a slot is deliberately skipped (holiday), with no identifying data", async () => {
    mock = createServer((req, res) => {
      pings.push(req.url ?? "");
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => mock!.listen(0, resolve));
    const addr = mock.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    process.env["HEARTBEAT_URL"] = `http://127.0.0.1:${port}/ping`;

    const user = await userWithCredentials();
    const result = await fireCron(user.id, "in", HOLIDAY);
    expect(result.outcome).toBe("skipped"); // no run row: a deliberate no-run

    // Give the fire-and-forget ping a moment to reach the server.
    await new Promise((r) => setTimeout(r, 50));
    expect(pings).toHaveLength(1);
    // No query string -> no place for an email/user/run id (privacy).
    expect(pings[0]).toBe("/ping");
    expect(pings[0]).not.toMatch(/[?&]/);
  });

  it("pings once when an outcome is terminal, and NOT while a retry is still queued", async () => {
    mock = createServer((req, res) => {
      pings.push(req.url ?? "");
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => mock!.listen(0, resolve));
    const addr = mock.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    process.env["HEARTBEAT_URL"] = `http://127.0.0.1:${port}/ping`;

    /** Today (Manila) at hour:minute, as an instant. */
    const todayAtManila = (hour: number, minute: number): Date => {
      const manilaDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Manila",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
      const [y, m, d] = manilaDate.split("-").map(Number);
      return new Date(Date.UTC(y!, m! - 1, d!, hour - 8, minute));
    };

    const user = await userWithCredentials();
    const started = await startRun({ userId: user.id, action: "out" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    // A failure that still has a retry queued is NOT an outcome: no ping.
    const queued = await finishRun(
      { run: started.run, status: "failure", error: "boom" },
      { now: todayAtManila(5, 35) },
    );
    expect(queued.retry).toBe("retry");
    expect(queued.pinged).toBe(false);
    expect(queued.notified).toBe(false); // the retry message replaces the ⚠️
    await new Promise((r) => setTimeout(r, 50));
    expect(pings).toHaveLength(0);

    // The same run, judged again past the clock-out cutoff, gives up and pings.
    await clearPendingRetry(user.id, "out", manilaDateString(new Date()));
    const [row] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, started.run.id))
      .limit(1);
    const gaveUp = await finishRun(
      { run: row!, status: "failure", error: "boom" },
      { now: todayAtManila(22, 45) },
    );
    expect(gaveUp.retry).toBe("give-up");
    expect(gaveUp.pinged).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(pings).toHaveLength(1);
  });

  it("no heartbeat URL -> zero pings", async () => {
    mock = createServer((req, res) => {
      pings.push(req.url ?? "");
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => mock!.listen(0, resolve));
    const addr = mock.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    // Deliberately NOT setting HEARTBEAT_URL — feature off.
    process.env["HEARTBEAT_URL"] = "";

    const user = await userWithCredentials();
    await fireCron(user.id, "in", HOLIDAY);
    await new Promise((r) => setTimeout(r, 50));
    expect(pings).toHaveLength(0);
    expect(port).toBeGreaterThan(0); // server was reachable; absence is meaningful
  });
});
