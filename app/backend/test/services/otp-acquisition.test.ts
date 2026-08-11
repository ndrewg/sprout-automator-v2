import { describe, expect, it, vi } from "vitest";
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
  waitForOtp: ReturnType<typeof vi.fn>;
  cancelWait: ReturnType<typeof vi.fn>;
  pollForOtp: ReturnType<typeof vi.fn>;
} {
  const waitForOtp = vi.fn<OtpAcquirerDeps["waitForOtp"]>(
    () => new Promise<string>(() => {}),
  );
  const cancelWait = vi.fn<OtpAcquirerDeps["cancelWait"]>(() => {});
  const pollForOtp = vi.fn<OtpAcquirerDeps["pollForOtp"]>(
    async () => "12345",
  );
  return { deps: { waitForOtp, cancelWait, pollForOtp }, waitForOtp, cancelWait, pollForOtp };
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
    const { deps } = makeFakeDeps();
    const { waitForOtpCode } = createOtpAcquirer("run-1", IMAP_CREDS, deps);

    await waitForOtpCode();
    const third = await waitForOtpCode();

    expect(third).toBe("12345");
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
    });

    const pending = waitForOtpCode();
    resolveManual("99999");
    expect(await pending).toBe("99999");
    expect(submittedCodes.has("99999")).toBe(true);
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
