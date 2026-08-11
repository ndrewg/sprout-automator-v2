import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client";
import { notificationSettings, runs } from "../../src/db/schema";
import { encrypt } from "../../src/lib/encryption";
import { executeQueuedRun } from "../../src/services/runs";
import {
  closeTestServer,
  createUser,
  request,
  resetDatabase,
  setupDatabase,
  startTestServer,
} from "./harness";

// The executor cannot reach the OTP step without a real browser and real
// HRHub, so the AggregateError path — Promise.any over the manual-OTP bridge
// and the IMAP poller both rejecting — is driven by stubbing runAutomation to
// throw the exact shape the live failure produced this morning. Everything
// downstream runs for real: the catch, the AggregateError unwrap, and the
// persisted runs.error against the test database.
vi.mock("../../src/automation/runAutomation", () => ({
  runAutomation: vi.fn(),
}));

import { runAutomation } from "../../src/automation/runAutomation";

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

describe("run OTP failure — AggregateError unwrapping", () => {
  let recorder: Recording;

  beforeAll(async () => {
    await setupDatabase();
    await startTestServer();
  });
  beforeEach(async () => {
    await resetDatabase();
    vi.mocked(runAutomation).mockReset();
    recorder = await startRecordingServer();
    process.env["TELEGRAM_API_BASE"] = recorder.baseUrl;
  });
  afterAll(async () => {
    delete process.env["TELEGRAM_API_BASE"];
    await recorder.close();
    await closeTestServer();
  });

  it("persists every underlying cause (and no credential material) in runs.error, and the notification carries it", async () => {
    const { user, cookie } = await createUser();
    await request("/credentials", {
      cookie,
      method: "PUT",
      body: {
        sproutUsername: "sprout-user",
        sproutPassword: "sprout-secret-pass-98765",
        gmailEmail: "otp-owner@example.com",
        gmailAppPassword: "gmail-app-pass-54321",
      },
    });
    await db.insert(notificationSettings).values({
      userId: user.id,
      telegramBotTokenEnc: encrypt(
        "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij", // gitleaks:allow
      ),
      telegramChatId: "123456789",
      enabled: true,
    });

    vi.mocked(runAutomation).mockRejectedValue(
      new AggregateError(
        [
          new Error("OTP timeout: no OTP submitted within time limit"),
          new Error("IMAP polling aborted"),
        ],
        "All promises were rejected",
      ),
    );

    const start = await request("/runs", {
      cookie,
      method: "POST",
      body: { action: "in" },
    });
    expect(start.status).toBe(202);
    const runId = (start.body as { run: { id: string } }).run.id;

    await executeQueuedRun(runId);

    const [finished] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);
    expect(finished?.status).toBe("failure");
    // Defect 3: the persisted error is the joined causes, NOT the opaque
    // "All promises were rejected" literal.
    expect(finished?.error).toBe(
      "OTP timeout: no OTP submitted within time limit; IMAP polling aborted",
    );
    // Rule 4: the unwrap must not drag credential material into runs.error.
    expect(finished?.error).not.toContain("sprout-secret-pass-98765");
    expect(finished?.error).not.toContain("gmail-app-pass-54321");
    expect(finished?.error).not.toContain("otp-owner@example.com");

    // The failure notification reads runs.error, so it inherits the unwrapped
    // message instead of the useless literal too.
    await waitFor(() => recorder.received.length > 0);
    expect(
      recorder.received.some(
        (r) =>
          r.includes("/sendMessage") &&
          r.includes("OTP timeout") &&
          r.includes("IMAP polling aborted"),
      ),
    ).toBe(true);
  });
});
