import { pollForOtp, type ImapCreds, type PollForOtpOptions } from "../lib/imap-otp";
import { cancelWait, waitForOtp } from "../automation/otp-bridge";

// The OTP acquisition step for one run. Extracted out of executeQueuedRun so it
// is unit-testable with the IMAP poller and the manual bridge injected — a test
// can drive two sequential attempts without a browser or a mailbox.
//
// Two defects were fixed here (2026-08): the AbortController is now per-attempt
// (a single run-scoped controller was aborted by the first acquisition's
// cleanup, leaving the retry path racing a permanently-dead IMAP poller), and
// every code this run returns is remembered so a retry cannot re-acquire the
// same stale email.

export type OtpAcquirerDeps = {
  waitForOtp: (runId: string) => Promise<string>;
  cancelWait: (runId: string) => void;
  pollForOtp: (creds: ImapCreds, options?: PollForOtpOptions) => Promise<string>;
  /**
   * The clock, injected (never `Date.now()` inline) so the request instant this
   * run anchors its IMAP search to is testable.
   */
  now: () => Date;
};

export type OtpAcquirer = {
  /** Race the manual bridge against IMAP polling; first code wins. */
  waitForOtpCode: () => Promise<string>;
  /** Every code this run has handed back, so later attempts can exclude them. */
  submittedCodes: ReadonlySet<string>;
};

const defaultDeps: OtpAcquirerDeps = {
  waitForOtp,
  cancelWait,
  pollForOtp,
  now: () => new Date(),
};

export function createOtpAcquirer(
  runId: string,
  imapCreds: ImapCreds | null,
  deps: OtpAcquirerDeps = defaultDeps,
): OtpAcquirer {
  const submittedCodes = new Set<string>();

  // The instant this run asked HRHub for an OTP (phase 17 § 17C). Recorded on
  // the FIRST acquisition of the run and reused for every later attempt: the
  // purpose is to discard mail that predates the request, and a retry within the
  // same run is re-submitting against the same login, so a later anchor could
  // only narrow the window onto mail this run is entitled to use. The 60 s
  // allowance in lib/imap-otp.ts absorbs the gap between the login submitting
  // and the OTP page being reached.
  let requestedAt: Date | null = null;

  const waitForOtpCode = async (): Promise<string> => {
    requestedAt ??= deps.now();
    // Fresh controller per attempt (locked D8/D9 keeps the Promise.any race,
    // but the loser must only ever stop THIS attempt's poller, not the whole
    // run's). Kept inside the acquisition so a retry races a live poller.
    const controller = new AbortController();
    const manual = deps.waitForOtp(runId);
    try {
      let code: string;
      if (imapCreds) {
        const imap = deps.pollForOtp(imapCreds, {
          signal: controller.signal,
          excludeCodes: submittedCodes,
          requestedAfter: requestedAt,
        });
        code = await Promise.any([manual, imap]);
      } else {
        code = await manual;
      }
      // Record it before returning: whatever this run submits once must not be
      // re-acquired by a later attempt (defect 2 — the stale-code retry loop).
      submittedCodes.add(code);
      return code;
    } finally {
      controller.abort();
      deps.cancelWait(runId);
    }
  };

  return { waitForOtpCode, submittedCodes };
}
