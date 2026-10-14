import { config } from "../config";
import { logger } from "../lib/logger";

// The in-memory FIFO with a Chromium cap (D6). Deliberately unchanged in its
// mechanism: at this scale a `SKIP LOCKED` job runner is over-engineering, and
// a dead process cannot resume a dead browser anyway. What phase 15A changed is
// only who owns the FAILURE BACKSTOP — the terminal write now belongs to the
// Run lifecycle, so the queue is handed a failure handler at startup instead of
// importing one (services/run-queue.ts ↔ services/run-lifecycle.ts would
// otherwise be an import cycle: the lifecycle needs the queue to enqueue).

type Job = { runId: string };
type Executor = (runId: string) => Promise<void>;
type FailureHandler = (runId: string, err: unknown) => Promise<void>;

export class RunQueue {
  private waiting: Job[] = [];
  private active = 0;
  private readonly cap: number;
  private executor: Executor | null = null;
  private failureHandler: FailureHandler | null = null;

  constructor(cap: number) { this.cap = cap; }
  setExecutor(fn: Executor): void { this.executor = fn; }

  /**
   * Register what to do when an executor rejects despite its own try/catch
   * (e.g. a DB error on the executor's initial run select). The Run lifecycle's
   * `failRunFromExecutor` ends the run through the one terminal step, so a
   * rejection is notified and retried like any other failure (backlog #2).
   */
  setFailureHandler(fn: FailureHandler): void { this.failureHandler = fn; }

  enqueue(job: Job): void { this.waiting.push(job); void this.drain(); }
  stats(): { active: number; waiting: number; cap: number } {
    return { active: this.active, waiting: this.waiting.length, cap: this.cap };
  }

  private async handleFailure(runId: string, err: unknown): Promise<void> {
    if (!this.failureHandler) {
      // Only reachable if a caller enqueues without registering the handler —
      // a wiring bug, and a silent one, so it is an error, not a debug line.
      logger.error(
        { runId, err },
        "run executor rejected and no failure handler is registered — the run may be left pending",
      );
      return;
    }
    await this.failureHandler(runId, err);
  }

  private async drain(): Promise<void> {
    if (!this.executor) return;
    while (this.active < this.cap && this.waiting.length > 0) {
      const job = this.waiting.shift();
      if (!job) break;
      this.active += 1;
      // Fire-and-forget: the run proceeds independently of the queue loop.
      // `void` marks the intentionally-unawaited promise for no-floating-promises.
      // The `.catch` is the backlog #2 backstop: an executor rejection must end
      // the run as a failure instead of becoming an unhandled rejection that
      // kills the process. The `.finally` bookkeeping keeps the queue slot
      // release the job it always was.
      // oxlint-disable promise/prefer-await-to-then -- the executor is intentionally fire-and-forget; the .catch/.finally must not block the queue loop (backlog #2).
      void this.executor(job.runId)
        .catch((err: unknown) => this.handleFailure(job.runId, err))
        .finally(() => {
          this.active -= 1;
          void this.drain();
        });
      // oxlint-enable promise/prefer-await-to-then
    }
  }
}

export const runQueue = new RunQueue(config.MAX_CONCURRENT_RUNS);
