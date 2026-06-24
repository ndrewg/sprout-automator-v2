import { inArray } from "drizzle-orm";
import { db } from "../db/client";
import { runs } from "../db/schema";
import { config } from "../config";

type Job = { runId: string };
type Executor = (runId: string) => Promise<void>;

class RunQueue {
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
      this.executor(job.runId).finally(() => {
        this.active -= 1;
        void this.drain();
      });
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
