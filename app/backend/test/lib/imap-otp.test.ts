import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchLatestOtp, pollForOtp } from "../../src/lib/imap-otp";

// imapflow is mocked so pollForOtp / fetchLatestOtp run against a fake inbox
// (module ownership: the real library only ever loads inside lib/imap-otp.ts,
// and a test must never touch real Gmail). The fake records every mailbox
// connection so "no fetch was performed" is assertable, and serves the test's
// inbox with UIDs ordered 1 → N (higher = newer), matching Gmail.

const fakeState = vi.hoisted(() => ({
  connectCalls: 0,
  inbox: [] as Array<{ source: Buffer; internalDate: Date }>,
}));

vi.mock("imapflow", () => ({
  ImapFlow: class {
    async connect(): Promise<void> {
      fakeState.connectCalls += 1;
    }
    async getMailboxLock(): Promise<{ release: () => void }> {
      return { release: () => {} };
    }
    async search(): Promise<number[]> {
      return fakeState.inbox.map((_, i) => i + 1);
    }
    async fetchOne(uid: string) {
      return fakeState.inbox[Number(uid) - 1];
    }
    async logout(): Promise<void> {}
  },
}));

const CREDS = { email: "otp-owner@example.com", appPassword: "app-pw-1234" };

function makeMessage(code: string): { source: Buffer; internalDate: Date } {
  return {
    source: Buffer.from(
      `Date: ${new Date().toUTCString()}\r\n` +
        `From: Sprout <no-reply@sprout.io>\r\n` +
        `To: otp-owner@example.com\r\n` +
        `Subject: Sprout verification code\r\n` +
        `\r\n` +
        `Your verification code is ${code}\r\n`,
    ),
    internalDate: new Date(),
  };
}

beforeEach(() => {
  fakeState.connectCalls = 0;
  fakeState.inbox = [];
});

describe("pollForOtp", () => {
  it("throws 'IMAP polling aborted' without ever contacting the mailbox when given an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      pollForOtp(CREDS, { signal: controller.signal, timeoutMs: 1000 }),
    ).rejects.toThrow("IMAP polling aborted");

    // The aborted-signal check fires BEFORE the first fetchLatestOtp, so no
    // mailbox connection was ever made (this is the property the production
    // bug depended on: a retry racing an aborted signal died without trying).
    expect(fakeState.connectCalls).toBe(0);
  });
});

describe("fetchLatestOtp code exclusion", () => {
  it("returns the newest code by default", async () => {
    fakeState.inbox = [makeMessage("11111"), makeMessage("22222")];
    const result = await fetchLatestOtp(CREDS, 300);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.code).toBe("22222");
  });

  it("skips a code already submitted in this run and returns the next distinct one", async () => {
    // The newest message (uid 2) carries the stale, already-submitted code; an
    // older one (uid 1) has a fresh code. Exclusion must make the poller skip
    // the newest and return the older, still-untried code.
    fakeState.inbox = [makeMessage("67890"), makeMessage("12345")];
    const result = await fetchLatestOtp(CREDS, 300, new Set(["12345"]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.code).toBe("67890");
  });

  it("reports no_code when every candidate code is already submitted", async () => {
    fakeState.inbox = [makeMessage("12345")];
    const result = await fetchLatestOtp(CREDS, 300, new Set(["12345"]));
    expect(result).toEqual({ ok: false, reason: "no_code" });
  });
});
