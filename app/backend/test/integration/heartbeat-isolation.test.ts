import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client";
import { runs } from "../../src/db/schema";
import { fireCron } from "../../src/services/scheduler";
import {
  closeTestServer,
  createUser,
  request,
  resetDatabase,
  setupDatabase,
  startTestServer,
} from "./harness";

// 12D — the dead-man's-switch heartbeat must never affect a run (hard rule 11,
// the same property notification-isolation proves for Telegram). A rejecting
// or hanging heartbeat endpoint must not fail, delay, or alter a scheduler
// fire, and a configured heartbeat pings exactly once per fire with no
// identifying data.

// A known weekday that is not a Philippine holiday, so fireCron reaches
// startRun (2026-08-11 = Tuesday, verified via isPhilippineHoliday).
const WORKDAY = new Date("2026-08-11T01:00:00Z");

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
    pings = [];
  });
  afterAll(async () => {
    if (mock) await new Promise((r) => mock!.close(r));
    delete process.env["HEARTBEAT_URL"];
    await closeTestServer();
  });

  it("a rejecting heartbeat endpoint does not fail or delay a scheduler fire, and the run proceeds", async () => {
    // Nothing listens on this port: the ping rejects immediately.
    process.env["HEARTBEAT_URL"] = "http://127.0.0.1:9";

    const { user, cookie } = await createUser();
    await request("/credentials", {
      cookie,
      method: "PUT",
      body: { sproutUsername: "hb-user", sproutPassword: "hb-pass-1234" },
    });

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

  it("a hanging heartbeat endpoint does not delay the fire", async () => {
    // A local server that accepts the connection but never responds.
    mock = createServer((_req, _res) => {
      /* never respond */
    });
    await new Promise<void>((resolve) => mock!.listen(0, resolve));
    const addr = mock.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    process.env["HEARTBEAT_URL"] = `http://127.0.0.1:${port}/never`;

    const { user, cookie } = await createUser();
    await request("/credentials", {
      cookie,
      method: "PUT",
      body: { sproutUsername: "hb-user2", sproutPassword: "hb-pass-2345" },
    });

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

  it("a configured heartbeat pings exactly once per fire and carries no identifying data", async () => {
    // A local server that records the request targets.
    mock = createServer((req, res) => {
      pings.push(req.url ?? "");
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => mock!.listen(0, resolve));
    const addr = mock.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    process.env["HEARTBEAT_URL"] = `http://127.0.0.1:${port}/ping`;

    const { user, cookie } = await createUser();
    await request("/credentials", {
      cookie,
      method: "PUT",
      body: { sproutUsername: "hb-user3", sproutPassword: "hb-pass-3456" },
    });

    await fireCron(user.id, "in", WORKDAY);

    // Give the fire-and-forget ping a moment to reach the server.
    await new Promise((r) => setTimeout(r, 50));
    expect(pings).toHaveLength(1);
    // No query string -> no place for an email/user/run id (privacy).
    expect(pings[0]).toBe("/ping");
    expect(pings[0]).not.toMatch(/[?&]/);
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

    const { user, cookie } = await createUser();
    await request("/credentials", {
      cookie,
      method: "PUT",
      body: { sproutUsername: "hb-user4", sproutPassword: "hb-pass-4567" },
    });

    await fireCron(user.id, "in", WORKDAY);
    await new Promise((r) => setTimeout(r, 50));
    expect(pings).toHaveLength(0);
    expect(port).toBeGreaterThan(0); // server was reachable; absence is meaningful
  });
});
