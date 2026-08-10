import { eq, inArray } from "drizzle-orm";
import { db } from "../db/client";
import { runs } from "../db/schema";
import { config } from "../config";
import { logger } from "../lib/logger";
import { stripAnsi } from "../lib/text";
import { notifyRunFinished } from "./notifications";

type Job = { runId: string };
type Executor = (runId: string) => Promise<void>;

/**
 * Backstop for a run executor that rejects despite executeQueuedRun's own
 * try/catch (e.g. a DB error on the initial run select). A run must never be
 * left pending because its executor threw — that is a silent failure neither
 * phase-6 safety net would report (backlog #2). Marks it failure and lets the
 * notification fire; swallows its own errors so the queue loop is never taken
 * down by a broken DB.
 */
async function failRunFromExecutor(runId: string, err: unknown): Promise<void> {
  try {
    const [run] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);
    if (!run) {
      logger.error({ runId, err }, "run executor rejected for a missing run");
      return;
    }
    // A terminal status means executeQueuedRun already handled the failure —
    // only a run still pending/running was left unhandled by the rejection.
    if (run.status !== "pending" && run.status !== "running") return;
    const message = err instanceof Error ? err.message : String(err);
    const [updated] = await db
      .update(runs)
      .set({
        status: "failure",
        error: stripAnsi(message),
        finishedAt: new Date(),
      })
      .where(eq(runs.id, runId))
      .returning();
    if (!updated) return;
    logger.error({ runId, err }, "run executor rejected — run marked failure");
    // Fire-and-forget (sanctioned idiom #2, §03): the notification must not
    // change the failure outcome, and notifyRunFinished never throws anyway.
    void notifyRunFinished({ run: updated, skipReason: null }).catch(() => {}); // oxlint-disable-line promise/prefer-await-to-then -- sanctioned fire-and-forget idiom (#2), §03.
  } catch (err2: unknown) {
    logger.error({ runId, err: err2 }, "failRunFromExecutor failed");
  }
}

export class RunQueue {
  private waiting: Job[] = [];
  private active = 0;
  private readonly cap: number;
  private executor: Executor | null = null;

  constructor(cap: number) { this.cap = cap; }
  setExecutor(fn: Executor): void { this.executor = fn; }
  enqueue(job: Job): void { this.waiting.push(job); void this.drain(); }
  stats(): { active: number; waiting: number; cap: number } {
    return { active: this.active, waiting: this.waiting.length, cap: this.cap };
  }
  private async drain(): Promise<void> {
    if (!this.executor) return;
    while (this.active < this.cap && this.waiting.length > 0) {
      const job = this.waiting.shift();
      if (!job) break;
      this.active += 1;
      // Fire-and-forget: the run proceeds independently of the queue loop.
      // `void` marks the intentionally-unawaited promise for no-floating-promises.
      // The `.catch` is the backlog #2 backstop: an executor rejection must mark
      // the run failure (failRunFromExecutor) instead of becoming an unhandled
      // rejection that kills the process. The `.finally` bookkeeping keeps the
      // queue slot release the job it always was.
      // oxlint-disable promise/prefer-await-to-then -- the executor is intentionally fire-and-forget; the .catch/.finally must not block the queue loop (backlog #2).
      void this.executor(job.runId)
        .catch((err: unknown) => failRunFromExecutor(job.runId, err))
        .finally(() => {
          this.active -= 1;
          void this.drain();
        });
      // oxlint-enable promise/prefer-await-to-then
    }
  }
}

export const runQueue = new RunQueue(config.MAX_CONCURRENT_RUNS);

export async function recoverOrphanedRuns(): Promise<number> {
  const result = await db
    .update(runs)
    .set({ status: "failure", error: "Interrupted by server restart", finishedAt: new Date() })
    .where(inArray(runs.status, ["pending", "running"]));
  return result.rowCount ?? 0;
}
