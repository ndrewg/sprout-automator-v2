import { describe, expect, it, vi, type Mock } from "vitest";
import {
  createOtpAcquirer,
  type OtpAcquirerDeps,
} from "../../src/services/otp-acquisition";

// The OTP acquisition step, extracted from executeQueuedRun specifically so it
// can be driven here with the IMAP poller and manual bridge injected — two
// sequential attempts on one run, no browser, no mailbox.
//
// The tests below encode the two defects they were written to catch:
//   1. The old code created ONE AbortController per run and aborted it after
//      the first acquisition. A retry (runAutomation calls waitForOtpCode
//      again when HRHub rejects the first code) then raced a permanently dead
//      IMAP poller — pollForOtp threw "IMAP polling aborted" before ever
//      contacting Gmail. Defect fixed: fresh controller per attempt.
//   2. The poller used to accept the newest code regardless of whether THIS
//      run had already submitted it. A stale email was re-acquired seconds
//      after the wait began, HRHub rejected it, and the retry loop repeated
//      the same mistake. Defect fixed: every handed-out code is remembered
//      and excluded from later IMAP polls.

const IMAP_CREDS = { email: "otp-owner@example.com", appPassword: "app-pw-1234" };

function makeFakeDeps(): {
  deps: OtpAcquirerDeps;
  waitForOtp: Mock<OtpAcquirerDeps["waitForOtp"]>;
  cancelWait: Mock<OtpAcquirerDeps["cancelWait"]>;
  pollForOtp: Mock<OtpAcquirerDeps["pollForOtp"]>;
} {
  const waitForOtp = vi.fn<OtpAcquirerDeps["waitForOtp"]>(
    () => new Promise<string>(() => {}),
  );
  const cancelWait = vi.fn<OtpAcquirerDeps["cancelWait"]>(() => {});
  const pollForOtp = vi.fn<OtpAcquirerDeps["pollForOtp"]>(
    async () => "12345",
  );
  return {
    deps: { waitForOtp, cancelWait, pollForOtp, now: () => new Date("2026-08-10T08:15:00Z") },
    waitForOtp,
    cancelWait,
    pollForOtp,
  };
}

describe("createOtpAcquirer", () => {
  it("races a live IMAP poller on the SECOND acquisition too — a fresh, non-aborted signal per attempt", async () => {
    const { deps, pollForOtp } = makeFakeDeps();
    // Snapshot aborted state AT CALL TIME: the acquirer aborts each attempt's
    // controller in its finally, so inspecting the live signal after the fact
    // always reads "aborted" and proves nothing.
    const captured: Array<{ signal?: AbortSignal; abortedAtCall: boolean }> = [];
    pollForOtp.mockImplementation(async (_creds, options) => {
      captured.push({
        signal: options?.signal,
        abortedAtCall: options?.signal?.aborted ?? false,
      });
      return "12345";
    });
    const { waitForOtpCode } = createOtpAcquirer("run-1", IMAP_CREDS, deps);

    const first = await waitForOtpCode();
    const second = await waitForOtpCode();

    expect(first).toBe("12345");
    expect(second).toBe("12345");
    // Both attempts reached the IMAP poller — the second one was not skipped
    // because a run-scoped controller had already been aborted.
    expect(pollForOtp).toHaveBeenCalledTimes(2);
    expect(captured).toHaveLength(2);
    // Both pollers were LIVE when handed to the race …
    expect(captured[0]?.abortedAtCall).toBe(false);
    expect(captured[1]?.abortedAtCall).toBe(false);
    // …and they are distinct controllers, not the same reused-and-aborted one.
    expect(captured[0]?.signal).not.toBe(captured[1]?.signal);
  });

  it("stops only the winning attempt's poller, not a future attempt's (abort after resolution is per-call)", async () => {
    // BACKLOG § 11.1: this used to only check the return value, which a mock
    // that ignores its signal returns either way — so it passed against the
    // run-scoped-controller bug. It now asserts on the signals themselves.
    const { deps, pollForOtp } = makeFakeDeps();
    const signals: AbortSignal[] = [];
    let secondAbortedAtCall: boolean | undefined;
    pollForOtp.mockImplementation(async (_creds, options) => {
      if (!options?.signal) throw new Error("the acquirer must pass a signal");
      signals.push(options.signal);
      if (signals.length === 2) secondAbortedAtCall = options.signal.aborted;
      return "12345";
    });
    const { waitForOtpCode } = createOtpAcquirer("run-1", IMAP_CREDS, deps);

    await waitForOtpCode();
    // The winning attempt's poller is stopped once its code is in hand …
    expect(signals[0]?.aborted).toBe(true);

    const second = await waitForOtpCode();

    expect(second).toBe("12345");
    // … and that abort did not reach the next attempt, which started live.
    expect(secondAbortedAtCall).toBe(false);
    expect(signals[1]).not.toBe(signals[0]);
  });

  it("passes the growing exclusion set so a code already returned is never handed out again", async () => {
    // Attempt 0 can only find the stale code; attempt 1 offers the stale one
    // again plus a fresh one. The acquirer's memory of the first code is what
    // forces the second attempt onto the fresh code.
    const candidatesByAttempt: string[][] = [["12345"], ["12345", "67890"]];
    let attempt = 0;
    const pollForOtp = vi.fn<OtpAcquirerDeps["pollForOtp"]>(
      async (_creds, options) => {
        const candidates = candidatesByAttempt[attempt] ?? [];
        attempt += 1;
        const excluded = options?.excludeCodes ?? new Set<string>();
        const fresh = candidates.find((code) => !excluded.has(code));
        if (!fresh) throw new Error("IMAP polling timed out: no OTP email arrived");
        return fresh;
      },
    );
    const { waitForOtpCode, submittedCodes } = createOtpAcquirer("run-1", IMAP_CREDS, {
      waitForOtp: () => new Promise<string>(() => {}),
      cancelWait: () => {},
      pollForOtp,
      now: () => new Date("2026-08-10T08:15:00Z"),
    });

    expect(await waitForOtpCode()).toBe("12345");
    expect(await waitForOtpCode()).toBe("67890");

    // The second attempt's poller call saw the first code in its exclusion set.
    const secondOptions = pollForOtp.mock.calls[1]?.[1];
    expect(secondOptions?.excludeCodes?.has("12345")).toBe(true);
    expect(submittedCodes.has("12345")).toBe(true);
    expect(submittedCodes.has("67890")).toBe(true);
  });

  it("records a manually pasted code too, so a retry's IMAP poll excludes it", async () => {
    let resolveManual!: (code: string) => void;
    const waitForOtp = vi.fn<OtpAcquirerDeps["waitForOtp"]>(
      () =>
        new Promise<string>((resolve) => {
          resolveManual = resolve;
        }),
    );
    const { waitForOtpCode, submittedCodes } = createOtpAcquirer("run-1", IMAP_CREDS, {
      waitForOtp,
      cancelWait: () => {},
      pollForOtp: () => new Promise<string>(() => {}),
      now: () => new Date("2026-08-10T08:15:00Z"),
    });

    const pending = waitForOtpCode();
    resolveManual("99999");
    expect(await pending).toBe("99999");
    expect(submittedCodes.has("99999")).toBe(true);
  });

  it("anchors every IMAP poll to the instant the run first asked for an OTP (17C)", async () => {
    // The run's request instant is captured once and reused, so a retry within
    // the same run cannot widen the window onto mail that predates the request.
    const request = new Date("2026-08-10T08:15:00Z");
    const seen: Array<Date | null | undefined> = [];
    const pollForOtp = vi.fn<OtpAcquirerDeps["pollForOtp"]>(
      async (_creds, options) => {
        seen.push(options?.requestedAfter);
        return "12345";
      },
    );
    const { waitForOtpCode } = createOtpAcquirer("run-1", IMAP_CREDS, {
      waitForOtp: () => new Promise<string>(() => {}),
      cancelWait: () => {},
      pollForOtp,
      now: () => request,
    });

    await waitForOtpCode();
    await waitForOtpCode();

    expect(seen).toEqual([request, request]);
  });

  it("does not start an IMAP poller when no gmail creds exist (manual bridge only)", async () => {
    let resolveManual!: (code: string) => void;
    const waitForOtp = vi.fn<OtpAcquirerDeps["waitForOtp"]>(
      () =>
        new Promise<string>((resolve) => {
          resolveManual = resolve;
        }),
    );
    const pollForOtp = vi.fn<OtpAcquirerDeps["pollForOtp"]>(
      async () => "12345",
    );
    const { waitForOtpCode } = createOtpAcquirer("run-1", null, {
      waitForOtp,
      cancelWait: () => {},
      pollForOtp,
      now: () => new Date("2026-08-10T08:15:00Z"),
    });

    const pending = waitForOtpCode();
    resolveManual("54321");
    expect(await pending).toBe("54321");
    expect(pollForOtp).not.toHaveBeenCalled();
  });

  it("the manual bridge wait and the cancel are keyed to the runId given", async () => {
    const { deps, waitForOtp, cancelWait } = makeFakeDeps();
    const { waitForOtpCode } = createOtpAcquirer("run-42", null, deps);

    let resolveManual!: (code: string) => void;
    waitForOtp.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveManual = resolve;
        }),
    );
    const pending = waitForOtpCode();
    resolveManual("11111");
    await pending;

    expect(waitForOtp).toHaveBeenCalledWith("run-42");
    expect(cancelWait).toHaveBeenCalledWith("run-42");
  });
});
