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

// --- Marker anchoring (the 2026-09-07/08 production failure) ----------------
// The IMAP search is bounded only by date, so the inbox handed to
// fetchLatestOtp contains whatever else arrived in the lookback window. Three
// consecutive runs submitted a wrong code and were bounced to the login page
// because an unrelated message won on UID order. A message with no OTP marker
// must now be skipped outright, and within a message the code must be anchored
// to a marker rather than being "the first 4-6 digit run".

function makeRawMessage(
  subject: string,
  body: string,
): { source: Buffer; internalDate: Date } {
  return {
    source: Buffer.from(
      `Date: ${new Date().toUTCString()}\r\n` +
        `From: Someone <someone@example.com>\r\n` +
        `To: otp-owner@example.com\r\n` +
        `Subject: ${subject}\r\n` +
        `\r\n` +
        `${body}\r\n`,
    ),
    internalDate: new Date(),
  };
}

describe("fetchLatestOtp marker anchoring", () => {
  it("ignores a NEWER unrelated email carrying a number and returns the real OTP", async () => {
    // uid 2 is newest and would have won on UID order alone — this is the
    // exact shape of the production failure.
    fakeState.inbox = [
      makeMessage("12345"),
      makeRawMessage("Your order has shipped", "Order 98765 is on its way."),
    ];
    const result = await fetchLatestOtp(CREDS, 300);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.code).toBe("12345");
  });

  it("reports no_code when nothing in the window carries an OTP marker", async () => {
    fakeState.inbox = [
      makeRawMessage("Your order has shipped", "Order 98765 is on its way."),
    ];
    expect(await fetchLatestOtp(CREDS, 300)).toEqual({
      ok: false,
      reason: "no_code",
    });
  });

  it("ignores a digit run too far from the marker to be the code", async () => {
    fakeState.inbox = [
      makeRawMessage(
        "Sprout notice",
        `verification code${" filler".repeat(60)} 55555`,
      ),
    ];
    expect(await fetchLatestOtp(CREDS, 300)).toEqual({
      ok: false,
      reason: "no_code",
    });
  });

  it("prefers the 5-digit code over a nearer 4-digit number", async () => {
    fakeState.inbox = [
      makeRawMessage(
        "Sprout verification code",
        "Your verification code for 2026 is 12345.",
      ),
    ];
    const result = await fetchLatestOtp(CREDS, 300);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.code).toBe("12345");
  });

  it("still accepts a 6-digit code when no 5-digit run is present", async () => {
    fakeState.inbox = [
      makeRawMessage("Sprout", "Your one-time password is 123456."),
    ];
    const result = await fetchLatestOtp(CREDS, 300);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.code).toBe("123456");
  });
});
