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
    return { ok: true, run };
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      return { ok: false, reason: "already_running" };
    }
    throw err;
  }
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
    await db
      .update(runs)
      .set({
        status: "failure",
        error: "No Sprout credentials available for this run",
        finishedAt: new Date(),
      })
      .where(eq(runs.id, runId));
    return;
  }

  const gmailEmail = cred ? decryptOptional(cred.gmailEmailEnc) : null;
  const gmailAppPassword = cred ? decryptOptional(cred.gmailAppPasswordEnc) : null;
  const imapAvailable = !!(gmailEmail && gmailAppPassword);

  await db.update(runs).set({ status: "running" }).where(eq(runs.id, runId));

  const log = (message: string): void => {
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
    await db
      .update(runs)
      .set({
        status,
        loginMethod: result.loginMethod,
        error: result.error ?? null,
        finishedAt: new Date(),
      })
      .where(eq(runs.id, runId));
  } catch (err: unknown) {
    cancelWait(runId);
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ runId, err }, "run execution failed");
    await db
      .update(runs)
      .set({ status: "failure", error: message, finishedAt: new Date() })
      .where(eq(runs.id, runId));
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

// Register the executor with the queue at module load (side-effect import).
runQueue.setExecutor(executeQueuedRun);
