import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client";
import { credentials, notificationSettings, runs } from "../../src/db/schema";
import { encrypt } from "../../src/lib/encryption";
import { executeQueuedRun } from "../../src/services/runs";
import { RunQueue } from "../../src/services/run-queue";
import {
  closeTestServer,
  createUser,
  request,
  resetDatabase,
  setupDatabase,
  startTestServer,
} from "./harness";

// Backlog #2 proof: nothing that can happen to a run's executor may become an
// unhandled rejection that kills the process. Two layers, both proven against a
// real database and a recording Telegram endpoint:
//   1. executeQueuedRun's own try/catch now contains the credentials decrypt,
//      so a wrong APP_ENCRYPTION_KEY (a corrupted *_enc row is its shape) ends
//      the run as `failure` with a notification attempt — the phase-6 safety
//      net — instead of an unhandled rejection.
//   2. The queue's .catch backstop marks a run failure (and notifies) even when
//      an executor rejection escapes executeQueuedRun entirely.
// Reaching an assertion at the end of each test IS the "process survives" part:
// an unhandled rejection would terminate the vitest worker mid-test.

type Recording = {
  baseUrl: string;
  received: string[];
  close: () => Promise<void>;
};

function startRecordingServer(): Promise<Recording> {
  const received: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c));
    req.on("end", () => {
      received.push(`${req.method} ${req.url} ${body}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok": true}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        received,
        close: () =>
          new Promise<void>((res) => {
            server.closeAllConnections();
            server.close(() => res());
          }),
      });
    });
  });
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function waitForRunTerminal(runId: string, ms = 3000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const [row] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);
    if (row && row.status !== "pending" && row.status !== "running") return;
    if (Date.now() - start > ms) {
      throw new Error("run never reached a terminal status");
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("run executor failure backstops", () => {
  let recorder: Recording;

  beforeAll(async () => {
    await setupDatabase();
    await startTestServer();
  });
  beforeEach(async () => {
    await resetDatabase();
    recorder = await startRecordingServer();
    process.env["TELEGRAM_API_BASE"] = recorder.baseUrl;
  });
  afterAll(async () => {
    delete process.env["TELEGRAM_API_BASE"];
    await recorder.close();
    await closeTestServer();
  });

  it("a corrupted *_enc row (decrypt failure) → the run ends failure WITH a notification attempt, process survives", async () => {
    const { user, cookie } = await createUser();
    await request("/credentials", {
      cookie,
      method: "PUT",
      body: { sproutUsername: "decrypt-user", sproutPassword: "sprout-pass-1234" },
    });
    // Corrupt the stored ciphertext — the exact shape a wrong
    // APP_ENCRYPTION_KEY produces for every stored credential.
    await db
      .update(credentials)
      .set({ sproutPasswordEnc: "garbage-ciphertext" })
      .where(eq(credentials.userId, user.id));
    await db.insert(notificationSettings).values({
      userId: user.id,
      telegramBotTokenEnc: encrypt(
        "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij", // gitleaks:allow
      ),
      telegramChatId: "123456789",
      enabled: true,
    });

    const start = await request("/runs", {
      cookie,
      method: "POST",
      body: { action: "in" },
    });
    expect(start.status).toBe(202);
    const runId = (start.body as { run: { id: string } }).run.id;

    // Run it directly — the queue's executor is only registered in the startup
    // path (phase T1), so this exercises executeQueuedRun's own try/catch.
    await executeQueuedRun(runId);

    const [finished] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);
    expect(finished?.status).toBe("failure");
    expect(finished?.error).toMatch(/ciphertext too short/i);
    expect(finished?.finishedAt).not.toBeNull();

    // The phase-6 safety net fired: the recording endpoint saw a sendMessage.
    await waitFor(() => recorder.received.length > 0);
    expect(recorder.received.some((r) => r.includes("/sendMessage"))).toBe(true);
  });

  it("a rejection escaping the executor is marked failure by the queue backstop and still notifies", async () => {
    const { user, cookie } = await createUser();
    await request("/credentials", {
      cookie,
      method: "PUT",
      body: { sproutUsername: "queue-user", sproutPassword: "sprout-pass-1234" },
    });
    await db.insert(notificationSettings).values({
      userId: user.id,
      telegramBotTokenEnc: encrypt(
        "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij", // gitleaks:allow
      ),
      telegramChatId: "123456789",
      enabled: true,
    });

    const start = await request("/runs", {
      cookie,
      method: "POST",
      body: { action: "in" },
    });
    expect(start.status).toBe(202);
    const runId = (start.body as { run: { id: string } }).run.id;

    // A dedicated queue whose executor rejects unconditionally — a stand-in for
    // whatever escapes executeQueuedRun's own try/catch (e.g. a DB error on its
    // initial run select). The backstop is what the drain loop's .catch runs.
    const queue = new RunQueue(1);
    queue.setExecutor(async () => {
      throw new Error("executor threw before any handling");
    });
    queue.enqueue({ runId });

    await waitForRunTerminal(runId);
    const [finished] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);
    expect(finished?.status).toBe("failure");
    expect(finished?.error).toBe("executor threw before any handling");
    expect(finished?.finishedAt).not.toBeNull();
    // The queue slot was still released.
    expect(queue.stats().active).toBe(0);

    await waitFor(() => recorder.received.length > 0);
    expect(recorder.received.some((r) => r.includes("/sendMessage"))).toBe(true);
  });
});
