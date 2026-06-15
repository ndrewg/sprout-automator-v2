# Phase 2 — Per-User Automation

**Goal:** the whole automation engine — Playwright clock-in/out, the run queue with DB race protection, IMAP OTP (racing manual fallback), the node-cron scheduler, and the PH holiday skip. After this phase the backend is feature-complete; only the UI remains.

**Attach for this session:** `03-CONVENTIONS-AND-GUARDRAILS.md`, `reference/hrhub-automation-playbook.md`, `reference/crypto-and-otp-specs.md`, `reference/api-contract.md`, `reference/database-schema.md`.

This is the biggest phase. Build in five sub-steps, each gated. **Feed them one at a time.**

> **Commit checkpoints** — commit only on a green gate; never a red one; *you* run the commit, not the agent. Suggested messages:
> - Gate 2A → `feat(phase-2): playwright automation modules (verbatim) [gate 2A]`
> - Gate 2B → `feat(phase-2): run queue + DB single-active-run guard [gate 2B]`
> - Gate 2C → `feat(phase-2): imap otp test + poll [gate 2C]`
> - Gate 2D → `feat(phase-2): /runs routes + executor wiring [gate 2D]`
> - Gate 2E → `feat(phase-2): node-cron scheduler + PH holiday skip [gate 2E]`
> Then tag: `git tag phase-2-complete`.

---

## 2A — Playwright automation modules

Create, **verbatim from `reference/hrhub-automation-playbook.md`**:
`src/lib/paths.ts`, `src/automation/screenshot.ts`, `src/automation/browser.ts`, `src/automation/portal.ts`, `src/automation/login.ts`, `src/automation/clock.ts`, `src/automation/runAutomation.ts`, and `src/automation/otp-bridge.ts` (from the crypto/OTP reference).

Do not modify selectors, the 1920×1080 viewport, the reload-after-OTP, or the fail-safe already-clocked guard. (See the invariants list in the playbook — they are load-bearing.)

Install the Playwright browser binary for native dev: `pnpm exec playwright install chromium`. (In Docker the base image already has it.)

**Gate 2A:** `pnpm typecheck` passes; nothing imports `playwright` outside `src/automation/`.

---

## 2B — Run queue + runs service

Create:
- `src/services/run-queue.ts` — the `RunQueue` class (in-memory FIFO, cap = `config.MAX_CONCURRENT_RUNS`, `setExecutor`/`enqueue`/`stats`/private `drain`) and `recoverOrphanedRuns()`. Export a singleton `runQueue`. Copy the structure from the spec below.
- `src/services/runs.ts` — `startRun`, `executeQueuedRun`, `listRuns`, `getRun`, `isRunWaitingForOtp`, `submitRunOtp`, `appendRunStep`; and `runQueue.setExecutor(executeQueuedRun)` at module load.

`run-queue.ts` (copy verbatim):
```ts
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
```

`runs.ts` key logic (the most important correctness code in the backend):
- **`startRun({userId, action})`**:
  1. Load the user's credentials row; if no `sproutUsernameEnc`/`sproutPasswordEnc` → `{ ok:false, reason:"no_credentials" }`.
  2. **`INSERT runs (userId, action, status:"pending")`** inside try/catch. On Postgres **`23505`** → `{ ok:false, reason:"already_running" }`. (This is the entire race guard — do NOT pre-check with a SELECT.)
  3. `runQueue.enqueue({ runId })`; return `{ ok:true, run }`.
- **`executeQueuedRun(runId)`** (the executor):
  1. Load the run; load the credentials; decrypt sprout username/password (if missing → mark run `failure`, return). Decrypt gmail email + app password; `imapAvailable = !!both`.
  2. `UPDATE runs SET status="running"`.
  3. `log = (msg) => appendRunStep(runId, msg)` (fire-and-forget, error logged).
  4. Build `waitForOtpCode`: start `waitForOtp(runId)` (manual bridge). If `imapAvailable`, also start `pollForOtp({email,appPassword},{signal})` and `Promise.any([manual, imap])`; in a `finally`, `otpAbort.abort()` + `cancelWait(runId)` so the loser stops. If not available, just await the manual bridge.
  5. `runAutomation({ userId, runId, action, creds, waitForOtpCode, log })`.
  6. Map result → status: `success` (`result.success && !skipped`), `skipped` (`result.success && skipped`), else `failure`. `UPDATE runs SET status, loginMethod, error?, finishedAt=now`.
  7. On thrown error: `cancelWait`, log, `UPDATE runs SET status="failure", error=message, finishedAt=now`.
- **`appendRunStep`**: `UPDATE runs SET steps = steps || '[{ts,message}]'::jsonb`.
- Decrypted creds live only as locals here — never logged, never on `req`.

**Gate 2B (the race test — this is the important one):**
1. `POST /runs {"action":"in"}` ×5 in parallel (same user). Expect **exactly one 202** and **four 409** `already_running`. (With no Chromium installed they'll all fail fast, but the 1×202/4×409 split must hold — that proves the partial index, not app logic, is gating.)
2. After the one run finishes (status leaves pending/running), a new `POST /runs` is allowed again.
3. Restart the backend mid-run → on boot, `recoverOrphanedRuns` flips the orphan to `failure` "Interrupted by server restart", and the user can start a new run.

---

## 2C — IMAP OTP

Create `src/lib/imap-otp.ts` **verbatim from `reference/crypto-and-otp-specs.md`** (if not already pulled forward in Phase 1C). Implement the real `POST /credentials/test-imap` (it was possibly stubbed in 1C): decrypt the stored gmail email + app password, call `testImapConnection`, return `{ok,messageCount}` or `400 {ok:false,error}`.

> ⚑ RECOMMENDED #2: add the `extractOtpCode` vitest cases from the reference now.

**Gate 2C:** `POST /credentials/test-imap` with no Gmail creds → `400 "Set gmailEmail and gmailAppPassword first."`. With deliberately wrong creds against real Gmail → `400 {ok:false}` with the humanized App-Password message (proves the connect + humanizer path).

---

## 2D — Run routes

Create `src/routes/runs.ts` per `reference/api-contract.md`: `POST /` (202/400/409), `GET /`, `GET /:id` (404 scoped), `POST /:id/otp` (validates `/^\d{4,6}$/`, 404/400 paths), `GET /queue/stats`. `publicRun(run)` computes `waitingForOtp = status==="running" && isRunWaitingForOtp(run.id)` and ISO-stringifies dates, defaults `steps` to `[]`.

Mount at `/runs`. In `index.ts`, **import `./services/runs` for its side effect** (registers the executor) before `app.listen`, and call `recoverOrphanedRuns()` in the startup sequence.

**Gate 2D:** with real Sprout + Gmail creds set, `POST /runs {"action":"in"}` → 202; poll `GET /runs/:id` and watch `steps` grow and `status` reach `success`/`skipped`/`failure`. (This is the first real end-to-end clock attempt — run it against HRHub.)

---

## 2E — Scheduler + holidays

Create:
- `src/lib/ph-holidays.ts` — verbatim from the crypto/OTP reference (`date-holidays` wrapper + `manilaDateString`). Install `date-holidays`.
- `src/services/scheduler.ts` — `timeToCronExpression`, `registerSchedule`, `unregisterSchedule`, `loadAllSchedules`, `activeScheduleCount`, and the private `fireCron`.
- `src/routes/schedule.ts` — `GET` / `PUT` per the contract.

`scheduler.ts` rules:
- `timeToCronExpression("05:30")` → `"30 5 * * 1-5"` (validate hour 0–23, minute 0–59, throw on bad input). **Weekday `1-5` lives in the expression**, not the handler.
- `registerSchedule(row)`: call `unregisterSchedule(userId)` first (atomic swap); if `!enabled`, stop there; else `cron.schedule(expr, () => void fireCron(userId, action), { timezone: "Asia/Manila" })` for both in and out; store in a `Map<userId,{clockIn,clockOut}>`.
- `fireCron(userId, action)`: **holiday check first** — `if (isPhilippineHoliday()) { log skip; return; }` — then `startRun({userId,action})`, catching any throw (never throw across the cron boundary), logging enqueued/skipped. Does **not** await execution.
- `loadAllSchedules()`: select `enabled` rows, `registerSchedule` each; called at boot.

`schedule.ts` rules (per contract):
- `GET` returns the row or defaults (`05:30:00`/`18:05:00`, `enabled:false`, `configured:false`) plus `today:{date:manilaDateString(now), holiday:isPhilippineHoliday(now)}`.
- `PUT` (`.strict()`, time regex, normalize `HH:MM`→`HH:MM:SS`) upserts, then **`registerSchedule(row)` if enabled else `unregisterSchedule(userId)`**, audits `schedule_updated`. Empty body → 400.
- **Lazy opt-in:** never create a row except via PUT; never default `enabled:true` for a user without a row.

In `index.ts` startup: `await loadAllSchedules()` and log the count.

> ⚑ RECOMMENDED #2: vitest for `timeToCronExpression` (valid + rejects "24:00", "5:99") and `manilaDateString`/`isPhilippineHoliday` (a known holiday → name; a known workday → null).

**Gate 2E:**
1. `GET /schedule` (fresh user) → defaults, `configured:false`, `enabled:false`, with today's date in Manila.
2. `PUT /schedule {"clockInTime":"05:30","enabled":true}` → 200 `configured:true`; backend log shows `registered: in="30 5 * * 1-5"` (Asia/Manila).
3. `PUT {"enabled":false}` → unregisters (log confirms); partial PUT preserves untouched fields.
4. Restart → boot log shows schedules rehydrated from DB.
5. Temporarily add today's date to `EXTRAS` in `ph-holidays.ts` → `GET /schedule` shows `today.holiday` set; remove it after.

If 2A–2E gates pass, Phase 2 is done — five gate commits should already be in history (see Commit checkpoints above). **n8n is fully obsolete.** Tag it: `git tag phase-2-complete`.
