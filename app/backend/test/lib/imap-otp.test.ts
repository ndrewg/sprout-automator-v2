import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchLatestOtp, pollForOtp } from "../../src/lib/imap-otp";

// imapflow is mocked so pollForOtp / fetchLatestOtp run against a fake inbox
// (module ownership: the real library only ever loads inside lib/imap-otp.ts,
// and a test must never touch real Gmail). The fake records every mailbox
// connection so "no fetch was performed" is assertable, and serves the test's
// inbox with UIDs ordered 1 → N (higher = newer), matching Gmail.
//
// Phase 17 § 17C changed the search twice over, and both halves are tested here:
// the any-sender fallback is GONE (Sprout's sender only), and a message whose
// internalDate predates the run's OTP request is discarded however good its code
// looks. IMAP SINCE has day precision (RFC 3501), so the internalDate check —
// not the search window — is what actually prevents a 16:15 run submitting the
// 05:30 code.

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
    async search(query?: { from?: string }): Promise<number[]> {
      const wanted = query?.from?.toLowerCase();
      return fakeState.inbox
        .map((_, i) => i + 1)
        .filter((uid) => {
          if (!wanted) return true;
          const msg = fakeState.inbox[uid - 1];
          return msg ? msg.source.toString().toLowerCase().includes(wanted) : false;
        });
    }
    async fetchOne(uid: string) {
      return fakeState.inbox[Number(uid) - 1];
    }
    async logout(): Promise<void> {}
  },
}));

const CREDS = { email: "otp-owner@example.com", appPassword: "app-pw-1234" };

/** A message from Sprout's real OTP sender (no-reply@sprout.ph). */
function makeSproutMessage(
  code: string,
  internalDate: Date = new Date(),
): { source: Buffer; internalDate: Date } {
  return {
    source: Buffer.from(
      `Date: ${internalDate.toUTCString()}\r\n` +
        `From: Sprout HR <no-reply@sprout.ph>\r\n` +
        `To: otp-owner@example.com\r\n` +
        `Subject: One-Time Password(OTP) for Sprout HR\r\n` +
        `\r\n` +
        `Enter the following OTP to finish logging in to Sprout HR ${code}\r\n`,
    ),
    internalDate,
  };
}

/** A message from anyone else, shaped exactly like an OTP notice. */
function makeOtherMessage(
  code: string,
  subject = "Your verification code",
): { source: Buffer; internalDate: Date } {
  return {
    source: Buffer.from(
      `Date: ${new Date().toUTCString()}\r\n` +
        `From: Somebody <someone@example.com>\r\n` +
        `To: otp-owner@example.com\r\n` +
        `Subject: ${subject}\r\n` +
        `\r\n` +
        `Your verification code is ${code}\r\n`,
    ),
    internalDate: new Date(),
  };
}

/** A Sprout message that is NOT an OTP notice (the payslip shape). */
function makeSproutNonOtp(
  subject: string,
  body: string,
): { source: Buffer; internalDate: Date } {
  return {
    source: Buffer.from(
      `Date: ${new Date().toUTCString()}\r\n` +
        `From: Sprout HR <no-reply@sprout.ph>\r\n` +
        `To: otp-owner@example.com\r\n` +
        `Subject: ${subject}\r\n` +
        `\r\n` +
        `${body}\r\n`,
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

  it("names Sprout's sender when nothing from it arrives — the likely cause is a changed address", async () => {
    // Only a mail from somebody else, which the search no longer considers.
    fakeState.inbox = [makeOtherMessage("24680")];

    await expect(
      pollForOtp(CREDS, { timeoutMs: 50, pollIntervalMs: 1 }),
    ).rejects.toThrow(/No OTP mail from Sprout's sender within \d+ min/);

    // The code never arrived because there is no Sprout mail — and the poller
    // only ever searched for Sprout's sender.
    expect(fakeState.connectCalls).toBeGreaterThanOrEqual(1);
  });
});

describe("fetchLatestOtp code exclusion", () => {
  it("returns the newest code by default", async () => {
    fakeState.inbox = [makeSproutMessage("11111"), makeSproutMessage("22222")];
    const result = await fetchLatestOtp(CREDS, { lookbackSeconds: 300 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.code).toBe("22222");
  });

  it("skips a code already submitted in this run and returns the next distinct one", async () => {
    // The newest message (uid 2) carries the stale, already-submitted code; an
    // older one (uid 1) has a fresh code. Exclusion must make the poller skip
    // the newest and return the older, still-untried code.
    fakeState.inbox = [makeSproutMessage("67890"), makeSproutMessage("12345")];
    const result = await fetchLatestOtp(CREDS, {
      lookbackSeconds: 300,
      excludeCodes: new Set(["12345"]),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.code).toBe("67890");
  });

  it("reports no_code when every candidate code is already submitted", async () => {
    fakeState.inbox = [makeSproutMessage("12345")];
    const result = await fetchLatestOtp(CREDS, {
      lookbackSeconds: 300,
      excludeCodes: new Set(["12345"]),
    });
    expect(result).toEqual({ ok: false, reason: "no_code" });
  });
});

// --- Marker anchoring (the 2026-09-07/08 production failure) ----------------
// Within Sprout's own mail, a message with no OTP marker must be skipped, and
// the code must be anchored to a marker rather than being "the first 4-6 digit
// run" — a payslip reference must not be submitted as a code.

describe("fetchLatestOtp marker anchoring", () => {
  it("ignores a newer Sprout mail carrying a number and returns the real OTP", async () => {
    // uid 2 is newest and would have won on UID order alone.
    fakeState.inbox = [
      makeSproutMessage("12345"),
      makeSproutNonOtp("Your August payslip", "Reference 98765 is ready."),
    ];
    const result = await fetchLatestOtp(CREDS, { lookbackSeconds: 300 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.code).toBe("12345");
  });

  it("reports no_code when nothing in the window carries an OTP marker", async () => {
    fakeState.inbox = [
      makeSproutNonOtp("Your August payslip", "Reference 98765 is ready."),
    ];
    expect(await fetchLatestOtp(CREDS, { lookbackSeconds: 300 })).toEqual({
      ok: false,
      reason: "no_code",
    });
  });

  it("ignores a digit run too far from the marker to be the code", async () => {
    fakeState.inbox = [
      makeSproutNonOtp(
        "Sprout notice",
        `verification code${" filler".repeat(60)} 55555`,
      ),
    ];
    expect(await fetchLatestOtp(CREDS, { lookbackSeconds: 300 })).toEqual({
      ok: false,
      reason: "no_code",
    });
  });

  it("prefers the 5-digit code over a nearer 4-digit number", async () => {
    fakeState.inbox = [
      makeSproutNonOtp(
        "Sprout verification code",
        "Your verification code for 2026 is 12345.",
      ),
    ];
    const result = await fetchLatestOtp(CREDS, { lookbackSeconds: 300 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.code).toBe("12345");
  });

  it("still accepts a 6-digit code when no 5-digit run is present", async () => {
    fakeState.inbox = [
      makeSproutNonOtp("Sprout", "Your one-time password is 123456."),
    ];
    const result = await fetchLatestOtp(CREDS, { lookbackSeconds: 300 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.code).toBe("123456");
  });
});

// --- Sprout's sender only (phase 17 § 17C) ----------------------------------
// The any-sender fallback is removed. It was there to survive an address change,
// but it silently widened the search to anything in the window, and the marker
// gate cannot separate two messages that both look like OTP notices.

describe("fetchLatestOtp sender scoping", () => {
  it("never uses a non-Sprout sender, even with a valid-looking code", async () => {
    fakeState.inbox = [makeOtherMessage("99999")];

    expect(await fetchLatestOtp(CREDS, { lookbackSeconds: 300 })).toEqual({
      ok: false,
      reason: "no_message",
    });
  });

  it("ignores a non-Sprout OTP notice in favour of Sprout's own mail", async () => {
    // uid 2 is newer AND carries an OTP marker, so a date-only search would hand
    // back 99999.
    fakeState.inbox = [makeSproutMessage("30415"), makeOtherMessage("99999")];
    const result = await fetchLatestOtp(CREDS, { lookbackSeconds: 300 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.code).toBe("30415");
  });
});

// --- Anchored to the request (phase 17 § 17C) -------------------------------

describe("fetchLatestOtp request anchoring", () => {
  const REQUEST = new Date("2026-08-10T08:15:00Z");

  it("discards a message received before the request, even as the newest UID with a valid code", async () => {
    // The 05:30 mail still in the inbox when the 16:15 run starts. It is the
    // newest (only) UID and its code is valid, so nothing but the internalDate
    // check stands between it and a wrong submission.
    fakeState.inbox = [
      makeSproutMessage("30415", new Date("2026-08-10T05:30:00Z")),
    ];

    const result = await fetchLatestOtp(CREDS, {
      lookbackSeconds: 300,
      requestedAfter: REQUEST,
    });

    expect(result).toEqual({ ok: false, reason: "no_code" });
  });

  it("accepts a message 30 s before the request (Gmail/host clock skew)", async () => {
    fakeState.inbox = [
      makeSproutMessage("30415", new Date(REQUEST.getTime() - 30_000)),
    ];

    const result = await fetchLatestOtp(CREDS, {
      lookbackSeconds: 300,
      requestedAfter: REQUEST,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.code).toBe("30415");
  });

  it("prefers the message received after the request when both are present", async () => {
    fakeState.inbox = [
      makeSproutMessage("11111", new Date("2026-08-10T05:30:00Z")),
      makeSproutMessage("22222", new Date(REQUEST.getTime() + 5_000)),
    ];

    const result = await fetchLatestOtp(CREDS, {
      lookbackSeconds: 300,
      requestedAfter: REQUEST,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.code).toBe("22222");
  });

  it("without a request instant it behaves as before (lookback window only)", async () => {
    fakeState.inbox = [
      makeSproutMessage("30415", new Date("2026-08-10T05:30:00Z")),
    ];

    const result = await fetchLatestOtp(CREDS, { lookbackSeconds: 300 });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.code).toBe("30415");
  });
});
