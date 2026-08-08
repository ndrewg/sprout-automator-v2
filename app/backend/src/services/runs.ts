import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { credentials, runs, type Run } from "../db/schema";
import { decryptOptional } from "../lib/encryption";
import { logger } from "../lib/logger";
import { runQueue } from "./run-queue";
import { runAutomation } from "../automation/runAutomation";
import {
  cancelWait,
  isWaitingForOtp,
  submitOtp,
  waitForOtp,
} from "../automation/otp-bridge";
import { pollForOtp } from "../lib/imap-otp";
import { stripAnsi } from "../lib/text";
import { notifyRunFinished } from "./notifications";
import type { ClockAction } from "../automation/clock";

type StartRunResult =
  | { ok: true; run: Run }
  | { ok: false; reason: "no_credentials" | "already_running" };

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}

export async function startRun(params: {
  userId: string;
  action: ClockAction;
}): Promise<StartRunResult> {
  const { userId, action } = params;

  const [cred] = await db
    .select()
    .from(credentials)
    .where(eq(credentials.userId, userId))
    .limit(1);
  if (!cred || !cred.sproutUsernameEnc || !cred.sproutPasswordEnc) {
    return { ok: false, reason: "no_credentials" };
  }

  // Insert as `pending` and let the partial unique index gate concurrency.
  // NEVER pre-check with a SELECT — the DB index is the race guard.
  try {
    const [run] = await db
      .insert(runs)
      .values({ userId, action, status: "pending" })
      .returning();
    if (!run) throw new Error("startRun: insert returned no row");
    runQueue.enqueue({ runId: run.id });
    logger.info({ runId: run.id, userId, action }, "run enqueued");
    return { ok: true, run };
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      return { ok: false, reason: "already_running" };
    }
    throw err;
  }
}

/**
 * The single terminal-state writer for a run: updates the DB, logs, and fires
 * the notification. Every place a run reaches a terminal status must go
 * through here so a notification is never silently skipped by a new code path.
 */
async function finalizeRun(
  run: Run,
  patch: {
    status: "success" | "skipped" | "failure";
    loginMethod?: string | null;
    error?: string | null;
    skipReason?: string | null;
  },
): Promise<void> {
  // skipReason is for the notifier only — it is not a DB column. And the error
  // is stripped of ANSI escapes before it is persisted, so the RunsPanel,
  // logs, and notification all see clean text (defect 3).
  const { skipReason, error: rawError, ...dbPatch } = patch;
  const error =
    rawError === undefined || rawError === null ? rawError : stripAnsi(rawError);
  const [updated] = await db
    .update(runs)
    .set({ ...dbPatch, error, finishedAt: new Date() })
    .where(eq(runs.id, run.id))
    .returning();
  if (!updated) throw new Error("finalizeRun: update returned no row");
  logger.info({ runId: run.id, status: patch.status }, "run finished");

  // Fire-and-forget (sanctioned idiom #2, §03). A notification must never
  // change run status or timing. notifyRunFinished never throws; the .catch
  // is belt-and-braces so a future refactor can't make this crash a run.
  void notifyRunFinished({
    run: updated,
    skipReason: skipReason ?? null,
  }).catch(() => {}); // oxlint-disable-line promise/prefer-await-to-then -- sanctioned fire-and-forget idiom (#2), §03.
}

export async function executeQueuedRun(runId: string): Promise<void> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (!run) {
    logger.error({ runId }, "executeQueuedRun: run not found");
    return;
  }

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
    await finalizeRun(run, {
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
  // and the loser is stopped in the finally.
  const otpAbort = new AbortController();
  const waitForOtpCode = (): Promise<string> => {
    const manual = waitForOtp(runId);
    if (imapAvailable && gmailEmail && gmailAppPassword) {
      const imap = pollForOtp(
        { email: gmailEmail, appPassword: gmailAppPassword },
        { signal: otpAbort.signal },
      );
      return Promise.any([manual, imap]).finally(() => {
        otpAbort.abort();
        cancelWait(runId);
      });
    }
    return manual;
  };

  try {
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
    await finalizeRun(run, {
      status,
      loginMethod: result.loginMethod,
      error: result.error ?? null,
      skipReason: result.skipReason ?? null,
    });
  } catch (err: unknown) {
    cancelWait(runId);
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ runId, err }, "run execution failed");
    await finalizeRun(run, { status: "failure", error: message });
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

export async function listRuns(userId: string): Promise<Run[]> {
  return db
    .select()
    .from(runs)
    .where(eq(runs.userId, userId))
    .orderBy(desc(runs.startedAt))
    .limit(20);
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
