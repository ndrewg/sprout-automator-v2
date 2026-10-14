import { clockAttempt, type ClockAttemptResult } from "./clock-attempt";
import type { SproutCreds } from "./login";
import { createPlaywrightPortal } from "./playwright-portal";
import type { ClockAction, LoginMethod } from "./portal-seam";

// The production entry point for one clock attempt: build the Playwright portal
// and hand it to the orchestration (clock-attempt.ts).
//
// It stays exported under this name because it is the boundary the rest of the
// app knows (`services/runs.ts`) and the seam the integration tests mock; what
// changed in phase 17 is that there is almost nothing left in it. The safety
// rules — read the card, decide, read it again, "unknown" — live above the
// portal, where a scripted fake can drive them without a browser.

export type { ClockAction, LoginMethod };

export type AutomationResult = ClockAttemptResult;

export type RunArgs = {
  userId: string;
  runId: string;
  action: ClockAction;
  creds: SproutCreds;
  waitForOtpCode: () => Promise<string>;
  log?: (message: string) => void;
};

export async function runAutomation(args: RunArgs): Promise<AutomationResult> {
  const { userId, runId, action, creds, waitForOtpCode, log } = args;

  const portal = createPlaywrightPortal({
    userId,
    runId,
    creds,
    waitForOtpCode,
    log,
  });

  try {
    return await clockAttempt(portal, { action, log });
  } finally {
    // Never throws: a browser that failed to launch, or that will not close,
    // must not change what the attempt concluded.
    await portal.close();
  }
}
