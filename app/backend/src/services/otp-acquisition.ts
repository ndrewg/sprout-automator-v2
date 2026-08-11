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
};

export function createOtpAcquirer(
  runId: string,
  imapCreds: ImapCreds | null,
  deps: OtpAcquirerDeps = defaultDeps,
): OtpAcquirer {
  const submittedCodes = new Set<string>();

  const waitForOtpCode = async (): Promise<string> => {
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
