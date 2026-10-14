import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { credentials, runs, type Run } from "../db/schema";
import { decryptOptional } from "../lib/encryption";
import { logger } from "../lib/logger";
import { runAutomation } from "../automation/runAutomation";
import {
  cancelWait,
  isWaitingForOtp,
  submitOtp,
} from "../automation/otp-bridge";
import { createOtpAcquirer } from "./otp-acquisition";
import { errorSummary } from "../lib/text";
import { finishRun } from "./run-lifecycle";

// The run EXECUTOR and the run history queries. Creation and every terminal
// write moved to services/run-lifecycle.ts (phase 15A, D20) — this module owns
// "how a run executes" (decrypt creds, race the OTP bridge against IMAP, drive
// Playwright) and "how runs are read back", not "what a run's state means".

export async function executeQueuedRun(runId: string): Promise<void> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (!run) {
    logger.error({ runId }, "executeQueuedRun: run not found");
    return;
  }

  // Everything that can fail at runtime — the credentials select, the decrypt
  // (a wrong APP_ENCRYPTION_KEY throws here), the runAutomation step, the
  // terminal write — lives inside ONE try so any of them takes the normal
  // failure path and reaches finishRun. A rejection that escapes this function
  // would otherwise bypass the terminal step entirely and kill the process
  // (backlog #2: decrypt used to sit outside this try).
  try {
    const [cred] = await db
      .select()
      .from(credentials)
      .where(eq(credentials.userId, run.userId))
      .limit(1);

    // Decrypted credentials live ONLY as locals here — never logged, never on req.
    const username = cred ? decryptOptional(cred.sproutUsernameEnc) : null;
    const password = cred ? decryptOptional(cred.sproutPasswordEnc) : null;
    if (!username || !password) {
      // Worth notifying about precisely because the user won't otherwise
      // discover their config is broken until payday.
      await finishRun({
        run,
        status: "failure",
        error: "No Sprout credentials available for this run",
      });
      return;
    }

    const gmailEmail = cred ? decryptOptional(cred.gmailEmailEnc) : null;
    const gmailAppPassword = cred ? decryptOptional(cred.gmailAppPasswordEnc) : null;
    const imapAvailable = !!(gmailEmail && gmailAppPassword);

    await db.update(runs).set({ status: "running" }).where(eq(runs.id, runId));
    logger.info({ runId, action: run.action }, "run started");

    const log = (message: string): void => {
      // Mirror each step to the backend logger AND persist it to runs.steps so
      // run progress is visible in the server logs, not only in the UI.
      logger.info({ runId }, message);
      void appendRunStep(runId, message);
    };

    // OTP acquisition races the manual bridge against IMAP polling; first wins,
    // and the loser is stopped in the acquirer's own finally. Each call gets a
    // fresh AbortController so a retry (runAutomation calls waitForOtpCode
    // again when the first code is rejected by HRHub) races a LIVE poller, and
    // the acquirer remembers every code handed out so a stale email's code is
    // never re-acquired (defect 1 + defect 2).
    const { waitForOtpCode } = createOtpAcquirer(
      runId,
      imapAvailable && gmailEmail && gmailAppPassword
        ? { email: gmailEmail, appPassword: gmailAppPassword }
        : null,
    );

    const result = await runAutomation({
      userId: run.userId,
      runId,
      action: run.action,
      creds: { username, password },
      waitForOtpCode,
      log,
    });
    const status = result.success
      ? result.skipped
        ? "skipped"
        : "success"
      : "failure";
    await finishRun({
      run,
      status,
      loginMethod: result.loginMethod,
      error: result.error ?? null,
      skipReason: result.skipReason ?? null,
    });
  } catch (err: unknown) {
    cancelWait(runId);
    const message = errorSummary(err);
    logger.error({ runId, err }, "run execution failed");
    await finishRun({ run, status: "failure", error: message });
  }
}

export async function appendRunStep(
  runId: string,
  message: string,
): Promise<void> {
  try {
    const step = { timestamp: new Date().toISOString(), message };
    await db
      .update(runs)
      .set({ steps: sql`${runs.steps} || ${JSON.stringify([step])}::jsonb` })
      .where(eq(runs.id, runId));
  } catch (err: unknown) {
    logger.error({ runId, err }, "appendRunStep failed");
  }
}

/**
 * Newest-first history for one user. `hasMore` is computed by selecting
 * `limit + 1` rows and reporting whether the extra row existed — never a second
 * COUNT(*) (phase 9A: a hardcoded .limit(20) silently dropped every older run).
 */
export async function listRuns(
  userId: string,
  limit: number,
): Promise<{ runs: Run[]; hasMore: boolean }> {
  const rows = await db
    .select()
    .from(runs)
    .where(eq(runs.userId, userId))
    .orderBy(desc(runs.startedAt))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  return { runs: rows.slice(0, limit), hasMore };
}

export async function getRun(
  userId: string,
  runId: string,
): Promise<Run | undefined> {
  const [row] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.userId, userId)))
    .limit(1);
  return row;
}

export function isRunWaitingForOtp(runId: string): boolean {
  return isWaitingForOtp(runId);
}

export function submitRunOtp(runId: string, code: string): boolean {
  return submitOtp(runId, code);
}

// NOTE: the run executor is registered with the queue in src/index.ts's
// start() — the startup path — NOT at module load. Registering here would mean
// importing the Express app (via routes/runs.ts) gives a route test a queue
// executor that could launch Chromium. Keep the registration in the startup
// path only (phase T1).
