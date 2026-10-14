# Phase 15 — Run lifecycle: no silent paths

**Goal:** every way a run can start, end or be interrupted goes through **one** module. Every ending notifies, decides on a retry and leaves durable state. A restart, a database error or a failed retry insert can delay a clock-in, but never make it vanish without a message.

**Why this exists.** The 2026-10-14 architecture review (`improve-codebase-architecture`, two independent agents, findings verified in the code) traced every *silent* failure it found to one shape: run state spread across seven modules and an in-memory Map. Silence is what cost three weeks in September (09-14 → 10-07). This phase absorbs **all** of the old phase 15, "Post-run remediation": its 15A degrade-not-throw is now 15A here and phase 16, its suite leak is 15E, its durable retries are 15B, its Gazette URL is moot because phase 16 removes the Gazette, and its schema-diff `[manual]` row is row 1 below.

**Attach for this session:** `02-DECISIONS-AND-ARCHITECTURE.md` (D6, D8, D17, and D20 below), `phases/phase-14-retry.md` (§ 14A/14B, the retry contract this keeps), `03-CONVENTIONS-AND-GUARDRAILS.md`, `reference/testing-strategy.md`.

> 🆕 **LATEST, UP-TO-DATE TECH, CODE AND REFERENCES. Mandatory.** Fetch current docs (Context7, then official docs) for every library, tool and service this phase touches. Write against the installed version's current API; add any new dependency at its latest stable release (within the pnpm cooldown); report outdated dependencies instead of bumping them mid-phase. Current docs beat any version or API this spec names. Full rule: `AGENTS.md` hard rule 1.

**Scope discipline.** No user-visible feature apart from clearer messages. The holiday, pause and weekend decision is phase 16, so leave `resolveHolidayDecision`'s merge rules alone here; only stop it from throwing (15A). Don't touch `automation/` (phase 17).

---

## What is wrong today (verified 2026-10-14)

| # | Path | What happens | Evidence |
|---|---|---|---|
| 1 | Restart mid-run | `recoverOrphanedRuns` marks the run `failure` **without** `finalizeRun`: no notification, no retry. After the restart, `fireDueSlot` sees the row and won't refire. The sweep's `hasRunToday` sees it and won't alert. **Silent.** | `services/run-queue.ts:92-98`, `services/scheduler.ts:159-176`, `services/notifications.ts:421` |
| 2 | Restart with a retry pending | The retry lives only in a Map (`retry-registry.ts`). The user was told "will retry at 06:05", then nothing: no attempt, no give-up message, no missed-run alert. **Silent.** | `services/retry-registry.ts` |
| 3 | `attemptRun` hits a non-unique database error | The outer catch logs and returns without `cancelPendingRetry`. The entry stays fired-and-pending forever, so `hasPendingRetry` stays true and **suppresses the missed-run alert** for that day. **Silent.** | `services/retry.ts:215-217` |
| 4 | Executor backstop | `failRunFromExecutor` writes `failure` and notifies, but **never schedules a retry**. | `services/run-queue.ts:20-52` |
| 5 | Database error on the first tick of a slot | The slot is added to `fired` **before** `fireCron` runs. `resolveHolidayDecision` is awaited **outside** `fireCron`'s try, and `loadGazetteForDate` has no catch. One error and the slot is lost for the day. **Silent.** | `services/scheduler.ts:203`, `:257`, `services/gazette.ts:63-69` |
| 6 | Two hosts both scheduling | The work PC and the laptop have separate databases. Each one's unique index and slot check only protect itself. Both clock, or each takes the other's OTP. | STATE.md "Two hosts" |
| 7 | Account deletion | `unregisterSchedule` is called, but pending retries aren't cancelled. | `routes/auth.ts:398` |

Two ways to create a run (`startRun` at `services/runs.ts:44-56`, `attemptRun` at `services/retry.ts:195-214`, which skips the credentials check) and three writers of a final status (`finalizeRun`, `failRunFromExecutor`, `recoverOrphanedRuns`) are why these paths drifted apart.

---

## 15A — One Run lifecycle module

**Contract:**
- A single module, e.g. `services/run-lifecycle.ts` (the name is the coder's call, recorded in STATE.md), owns:
  - **creating** a run, for every trigger: scheduled slot, retry, manual click;
  - **every** write of a final status: normal finish, executor backstop, orphan recovery at boot;
  - the **retry decision** after a failure;
  - the **outcome notification**, sent once per final status.
- **One creation path.** The retry path stops inserting and enqueueing on its own. It goes through the same create step as a manual or scheduled run, including the credentials check and the `23505` → "already running" handling.
- **One terminal path.** `failRunFromExecutor` and orphan recovery become callers of the same finish step as a normal result.
  - **An orphaned run is notified and retried like any other failure** (decided 2026-10-14). The error text stays `Interrupted by server restart`. Retrying is safe because the already-clocked guard reads HRHub before clicking, and phase 17 hardens that guard.
- **Notifications** stay in `services/notifications.ts` (render and send). The lifecycle decides *which* message is sent; that module decides *how* it looks.
- **The run queue stays as it is** (D6): an in-memory FIFO with a Chromium cap, plus the partial unique index. Only *retry and slot state* move to the database; nothing tries to resume a dead browser.
- **Heartbeat on outcome.** Move `pingHeartbeat()` from the fire path (`scheduler.ts:256`) to the lifecycle's terminal step, and ping on success, on a deliberate skip (holiday, pause, already clocked) and on give-up. An outside monitor then means "today's slot reached an outcome", not "the tick ran". Keep it fire-and-forget (hard rule 11).
- **Account deletion** cancels the user's pending retries, through the lifecycle.

**Tests (integration):** drive the module's interface (trigger in → status, retry state and messages out), with the queue executor and the notification send function injected.
- A run whose executor throws gets a retry scheduled (path 4).
- Orphan recovery at boot: the user is notified and a retry is scheduled when within the cutoff; past the cutoff, the give-up message is sent instead (path 1).
- A retry whose insert fails with a non-unique error is **not** left pending, so the missed-run sweep can alert (path 3).
- A manual click while a retry is pending supersedes it (existing 14B behaviour, now through one path).
- Deleting an account leaves no pending retry.

**Gate 15A:** `cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration`

---

## 15B — Retry state survives a restart

**Contract:**
- Persist the pending retry on the failed run's own row: a nullable `retry_at` (timestamptz). **Set** means a retry is due at that time; **null** means none (never scheduled, fired, or cancelled). The decision recorded in D20 is: one column, no new table, because a pending retry is a property of the latest failed attempt.
- The tick reads due retries from the database (`retry_at <= now`), with no Map. **Delete `services/retry-registry.ts`** along with the notifications ↔ retry import-cycle workaround it exists for (its header comment). `hasPendingRetry` becomes a database read.
- **Claim a due retry atomically** (for example `UPDATE … SET retry_at = NULL WHERE id = $1 AND retry_at IS NOT NULL RETURNING …`), so two ticks or a restart can never fire it twice.
- Every existing guard still applies when a retry fires, **including after a restart**: the attempt cap, the wall-clock cutoff, the holiday and pause checks, and the day rollover. **A restored retry past its cutoff is discarded and the give-up message is sent. It never fires a 14:00 clock-in.**
- Cancellation (success, a manual run, the next scheduled fire, the day rolling over, account deletion) sets `retry_at` to null.
- New migration. **Never edit a committed migration.**

**Tests (integration):**
- A pending retry survives a simulated restart (reset in-process state, keep the database) and fires at its time.
- A retry whose cutoff passed during the restart is discarded with a give-up message, not fired.
- The missed-run alert stays suppressed while `retry_at` is set, across the restart.
- A retry cancelled before the restart doesn't come back.
- Two concurrent claims of the same due retry produce one run.

**Gate 15B:** `cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration`

---

## 15C — A slot is only "fired" once it has a run

**Contract:**
- In `schedulerTick`, a slot's in-memory `fired` entry is a **re-entrancy guard**, not the record. If the fire fails **before** a run row or a deliberate skip exists (a database error, a thrown decision), remove the entry so the next tick tries again, up to the end of the slot's window. Log each failed attempt once.
- The whole fire path, from the decision through enqueue, sits inside one try, so the boundary contract holds whatever a future awaited call does (old 15A's widening, carried over).
- `fireDueSlot` passes the tick's `now` into the fire path. The holiday and pause checks must not take a second `new Date()` (`scheduler.ts:192`, `:248`).
- **Late wake: alert only** (decided 2026-10-14). The fire window stays at `MISSED_RUN_GRACE_MINUTES`. A host that comes up after it doesn't clock in. Instead, the missed-run message says so plainly: *"Missed the 05:30 clock-in (the automator wasn't running). Clock in yourself if you're working today."* **Why:** the operator pauses by powering off, so a late automatic clock-in would put a false record on days off.

**Tests (unit, fake timers, no database):** the tick glue that phase-15-era tests never covered.
- A fire that throws before creating a run is retried on the next tick, and stops at the window's end.
- A slot fires once per day across many ticks.
- The sweep runs once per 5-minute bucket.
- The fire path receives the tick's instant.

**Gate 15C:** `cd app/backend && pnpm lint && pnpm typecheck && pnpm test`

---

## 15D — One host schedules

**Contract:**
- New config key **`SCHEDULER_ENABLED`**, boolean, **default `false`**. When false, `startScheduler()` is not called: no slots, no retries, no sweep, no nightly jobs. Manual runs and the UI still work. Log one line at boot either way.
- Add it to `config.ts`, `.env.example` **and both compose files** in this gate (phase 8's lesson: a key that doesn't reach the container doesn't exist).
- `/health` reports `scheduler.enabled`.
- **Why default false:** a dev machine or a second laptop must never clock anyone by accident. Opting in is one line in the scheduled host's `.env`. **The operator sets it to `true` on the laptop before deploying this phase**, or the laptop stops clocking. Put that in the phase report and in STATE.md's deployment notes.

**Tests:** booting with the key unset or false registers no tick handlers; with true, the scheduler starts. A malformed value refuses to boot.

**Gate 15D:** `cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration` · `docker compose config 2>&1 | grep -c "is not set"` must be `0`

---

## 15E — A trustworthy suite baseline

Carried over from the old 15B.
- Every module-global reset (`resetSchedulerState`, `stopWallClockTick`, any retry state) runs in a **shared** `afterEach` in the integration project's setup, not as a per-file habit.
- `stopWallClockTick()` currently drops **every** handler, including the scheduler's. Make the reset per-consumer, or document that tests must re-register.
- Run the whole suite **twice from cold** (backend unit + integration, frontend unit + e2e). Paste both sets of counts verbatim, and record them in `STATE.md`, replacing the stale 161 / 106 / 5 / 16 baseline.
- If flakiness survives, **say so and stop.** A gate that needs `--retry` is not a gate.

**Gate 15E:** the full suite, twice, from cold, with counts pasted.

---

## Verification Gate (the whole phase)

```
cd app/backend  && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration
cd app/frontend && pnpm lint && pnpm test && pnpm build && pnpm test:e2e
docker compose config 2>&1 | grep -c "is not set"
```

**`[manual]`: must not be claimed as passed:**

| # | Check | Pass looks like |
|---|---|---|
| 1 | **Before applying this phase's migration:** restore the latest backup into a scratch DB, run `pnpm db:migrate` **from empty**, and diff tables, indexes and constraints against the live `sprout` DB | Identical, including the `runs_one_active_per_user` partial index. This is phase 10's unverified row; it comes first |
| 2 | Set `SCHEDULER_ENABLED=true` on the laptop, deploy, check the boot log and `/health` | `scheduler.enabled: true`; the next slot fires |
| 3 | Restart the container while a retry is pending | The retry fires at its time; one give-up or success message, no duplicate missed-run alert |
| 4 | Restart the container **during** a run | You get an "interrupted" message and a retry; HRHub shows exactly one clock entry |
| 5 | On the work PC, leave `SCHEDULER_ENABLED` unset and boot | Log says the scheduler is disabled; no slot fires |

Commit per the loop in `AGENTS.md`. Tag `phase-15-complete` when the table is filled in.
