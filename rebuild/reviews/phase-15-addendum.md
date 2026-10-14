# Phase 15 addendum — tester's report

**Tester:** phase-15 test round, 2026-10-14, on `DESKTOP-3SV8V8A` (work PC — dev, not the scheduled laptop).
**Method:** every gate re-run from scratch; report diffed against `git status`/`git diff`; six fault-injection probes (break → red → restore → green, byte-exact restoration proven by re-running the full suite); live boot probes against `sprout_test` only; direct `psql` inspection. No source changes remain — `git grep "FAULT PROBE"` is empty and the full suite is green at the recorded counts after restoration.

---

## A — what I verified structurally (confirm, don't repeat)

### A0. Gates re-run (all green; counts match the report and STATE.md's new baseline)

| Gate | Result |
|---|---|
| `app/backend pnpm lint` / `pnpm typecheck` | clean (oxlint, tsc) |
| `app/backend pnpm test` | **25 files / 262 tests passed** |
| `app/backend pnpm test:integration` | **30 files / 171 tests passed** (run twice: initial + post-restoration) |
| `app/frontend pnpm lint` / `pnpm build` | clean / built |
| `app/frontend pnpm test` | 1 file / **5 passed** |
| `app/frontend pnpm test:e2e` | **16 passed** |
| `docker compose config` "is not set" | **0** (base) and **0** (base+prod overlay) |

No count went down. The 262 / 171 / 5 / 16 baseline recorded in STATE.md is what I measured.

### A1. Gate 15A — one lifecycle module (code refs)

- `app/backend/src/services/run-lifecycle.ts:113-149` — `startRun` is the single creation path: credentials check → insert `pending` → `23505`→`already_running` (`isUniqueViolation`) → `clearPendingRetry`. Callers: `routes/runs.ts:45` (manual), `scheduler.ts` `fireCron` (slot), `fireClaimedRetry` (retry) — no other INSERT into `runs` for new runs exists (`runs.ts` diff removed the old one; `retry.ts`'s `attemptRun` is gone).
- `run-lifecycle.ts:188-232` — `finishRun` is the single terminal writer: status UPDATE → retry decision (`scheduleRetryOnFailure`, failures only) → exactly one message (⚠️ only when the decision is `"none"`) → heartbeat (`pinged = status !== "failure" || retry !== "retry"` — no ping while a retry is queued, per spec).
- `run-lifecycle.ts:244-270` `failRunFromExecutor` and `:281-297` `recoverOrphanedRuns` are both callers of `finishRun`; orphan error text unchanged (`"Interrupted by server restart"`). `run-queue.ts` no longer writes terminal state; the handler is injected via `setFailureHandler` (`index.ts:56`) — the documented cycle-break, and an unregistered handler logs an error rather than staying silent (`run-queue.ts` `handleFailure`).
- `routes/auth.ts:398-404` — account deletion awaits `cancelPendingRetriesForUser` (ordering: unregister → cancel retries → audit → delete), tested by `run-lifecycle.test.ts:331-348`.
- `services/gazette.ts` — `loadGazetteForDate` now try/catch → warn-once → `[]` (degrade to library); confirmed in the diff.
- `services/scheduler.ts` — `pingHeartbeat` import removed from the fire path; heartbeat now pings via `noteDeliberateSkip` (holiday/pause) and `finishRun`.

### A2. Gate 15B — durable retry state

- `db/schema.ts` — `retryAt: timestamp("retry_at", { withTimezone: true })`, nullable. **Verified in the live `sprout_test` schema via psql**: `retry_at | timestamp with time zone | nullable`, and `runs_one_active_per_user` partial unique index intact.
- `drizzle/0008_run_retry_at.sql` = `ALTER TABLE "runs" ADD COLUMN "retry_at" timestamp with time zone;` — new file only; `git diff --stat app/backend/drizzle/` shows **only** `_journal.json` + two new files (`0008_run_retry_at.sql`, `meta/0008_snapshot.json`). **No committed migration was edited** (hard rule 13 ✅).
- `retry-state.ts:140-147` — `claimRetry` is the correct atomic claim: one `UPDATE … SET retry_at = NULL WHERE id = $1 AND retry_at IS NOT NULL RETURNING …`; no SELECT-then-UPDATE anywhere.
- `retry-state.ts:68-110` — `findPendingRetry`/`clearPendingRetry` key on `retry_at`'s own Manila day, so a claimed/cancelled retry can't suppress another day's alert.
- `retry-registry.ts` deleted (`git status` D); no stale imports (typecheck clean). The sweep's `hasPendingRetry` is now an awaited DB read (`notifications.ts:446-449`, `:527-532`).
- `psql sprout_test`: `drizzle.__drizzle_migrations` has **9 rows**, newest `created_at 1791941621470` matching the journal's `0008` entry. The live `sprout` DB on this work PC does **not** yet have `retry_at` (0 rows) — expected, and correctly flagged as the deploy blocker in STATE.md:51.

### A3. Gate 15C — slot re-entrancy

- `scheduler.ts` `schedulerTick` — `fired.add(key)` before await (re-entrancy guard), `fired.delete(key)` unless `isSlotHandled(result)` or on throw; each failed attempt logs once (`warn`). `fireCron`'s whole path, holiday decision included, sits in one try and returns `FireResult`. `fireDueSlot` passes the tick's `now` through `fireCron`, threading it into holiday/pause checks and `startRun({ manilaDate })` — no second `new Date()` in the decision path.
- `notifications.ts:144-158` — `renderMissedMessage` matches the specced late-wake wording ("Missed the 05:30 clock-in … The automator wasn't running … Clock in yourself if you're working today.").

### A4. Gate 15D — one host schedules

- `config.ts:133-140` — `SCHEDULER_ENABLED` strict `enum(["true","false"])`, default `"false"`, empty-string → default; `schedulerEnabled()` (lines 250-260) lazily prefers `process.env`.
- `scheduler.ts` `startScheduling()` is the single boot gate (called from `index.ts`), logs one line either way; `startScheduler()` registers `"scheduler"` + `"retries"` ticks; gazette refresh only starts when enabled.
- `app.ts /health` — reports `scheduler.enabled`; "enabled in DB, none registered" degrades **only** when `enabled` is true.
- `.env.example` + **both** `docker-compose.yml` and `docker-compose.prod.yml` carry `SCHEDULER_ENABLED: ${SCHEDULER_ENABLED:-}` — confirmed in the diffs and `docker compose config` renders 0 "is not set" for base and prod overlay.

**Live boot probes (real `tsx src/index.ts` processes against `sprout_test` only, port 3999, killed after):**
- Key **unset** → boot log `scheduler disabled (SCHEDULER_ENABLED is not true) — no daily slots…`; `/health` = `{"status":"ok", … "scheduler":{"enabled":false,"registered":0,…,"lastTickAt":null}}` HTTP 200; no tick armed. ✅
- `SCHEDULER_ENABLED=yes` → process refuses to boot: `Error: Invalid environment configuration: - SCHEDULER_ENABLED: expected "true" or "false"`. ✅
- `SCHEDULER_ENABLED=true` → boot log `scheduler enabled …`, `lastTickAt` advancing, `/health` `enabled:true` HTTP 200. ✅
- `POST /runs` and `GET /runs` with no cookie → **401 "Not authenticated"** (`routes/runs.ts:15` `runsRouter.use(requireAuth)` intact). ✅

### A5. Gate 15E — suite hygiene

- `vitest.config.ts` integration project gains `setupFiles: ["./test/integration/setup.ts"]`; the setup file's shared `afterEach` resets scheduler state and stops the tick, and imports `services/scheduler` **dynamically** as documented. `wall-clock-tick.ts` gains `offTick(name)` + `tickHandlerNames()`.

### A6. Report-vs-reality diff

- The implementer's STATE.md edits (queue row 20, deploy blocker line 51, phase-15 row, Known-gaps updates) are **accurate** against everything I measured (counts, `SCHEDULER_ENABLED` behaviour, `retry_at` existence, registry deletion). Per AGENTS.md "Keep the ledger current", writing STATE.md/BACKLOG.md/phase as-built notes is the implementer's job and they belong in the reviewer's phase commit — appropriate, not over-reach.
- `.opencode/agent/orchestrator.md` and `opencode.json` diffs are permission/tooling changes unrelated to phase 15 — consistent with the report's "not mine" claim.
- **Files changed but NOT reported:** `test/integration/missed-run-sweep.test.ts` (missed-message wording assertions), `test/services/notifications.test.ts` (same wording + `retryAt: null` in the fixture + async `hasPendingRetry`), `drizzle/meta/_journal.json` (implied by the generated migration), `rebuild/BACKLOG.md` §7 supersede note. All four are legitimate and in-scope; the omission is a reporting gap, not a scope leak.
- **Claimed but NOT in the diff:** the report says `otp-error-unwrap` was "updated" — `git diff` on that file is empty (last touched in commit `837abd9`).
- No deferred work leaked in: nothing from phases 16/17 appears in the diff; `automation/` untouched.

### A7. LATEST-TECH check (mandatory, 2026-10-14)

Registry checked today (`pnpm view <pkg> version`): zod **4.6.7** (installed ^3.23.8), typescript **7.0.2** (dev), vitest **5.0.4** (installed 4.1.x), drizzle-orm **0.45.4** (^0.45.2), express **5.3.0** (^5.1.0), express-rate-limit **8.7.1** (^7.4.1), pino **10.4.0** (^9.5.0), imapflow **2.4.0** (^1.7.2), playwright **1.64.0** (pinned 1.60.0 — deliberately, Docker base image). The report's outdated-dep list is **accurate** and correctly *reported, not bumped* per AGENTS.md. **No new dependency was added** this phase (zero new supply-chain surface). New APIs used (drizzle `update/returning`, zod 3 `enum`+`errorMap` — correct for the installed zod 3, Express 5 async handlers, Node timers) are current for the installed versions; nothing deprecated detected. The playwright pin must stay until the Docker base image moves (D1/D12).

---

## B — defects found

### B1 — **[Medium] The "two concurrent claims produce one run" test cannot fail against a non-atomic claim**
**Proved by fault injection:** I removed `AND retry_at IS NOT NULL` from `claimRetry`'s WHERE clause (making the claim non-atomic — two claimants both get the row back) and re-ran `durable-retry.test.ts`: **all 8 tests stayed green.** The partial unique index `runs_one_active_per_user` absorbs the duplicate — the second `createRun` hits `23505` → `already_running` → no second run row. So the test `durable-retry.test.ts:270-283` proves only what the DB index already guaranteed independently, **not** the atomic claim the phase contract requires. A future refactor could drop the atomic claim and the suite would stay green. The scenario the atomic claim actually protects — a double-claimed **past-cutoff** retry sending **two 🛑 give-up messages** (both claimants run `fireClaimedRetry`'s discard path, each `void notifyRetryGiveUp(run)`) — has no test. Not BLOCKING (the shipped code is correct); it is exactly the "test that reads as coverage" class this project has been burned by.

### B2 — **[Low] A transient DB error in the retry decision makes a failure vanish without any message**
`finishRun` (`run-lifecycle.ts:204-215`) writes the terminal status **first**, then calls `scheduleRetryOnFailure`, which awaits `hasPendingRetry`/`setRetryAt` (DB reads/writes). Concrete failure scenario: a run fails at 05:35; the DB connection resets exactly during `setRetryAt` → `scheduleRetryOnFailure` throws → `executeQueuedRun`'s catch calls `finishRun` again with the stale `run` row → if the DB is still down, that throws too → the executor rejects → `failRunFromExecutor` sees the run is already terminal and returns. End state: `runs.status = "failure"`, **no ⚠️, no "will retry", no retry queued, no heartbeat** — the precise silent-path class phase 15 exists to close. Window is one transient DB error, and a full outage would block the notifier anyway, but a blip that recovers one second later still loses the message permanently (and the second `finishRun` pass can overwrite the run's `error` with the DB-error text instead of the automation diagnosis). Suggested direction (coder's call): catch the retry decision's throw inside `finishRun` and degrade to `"none"` (⚠️ still sent) rather than letting it escape.

### B3 — **[Low] A claimed retry discarded for `no_credentials` is silent — contradicting the report's own claim (5)**
`fireClaimedRetry` (`run-lifecycle.ts:450-455`): when the creation path returns `not_started`, the code only logs `"retry run not created"`. Every other discard reason (cutoff, cap, day rollover) sends the give-up message (as-built note 7: "A discarded retry notifies for EVERY discard reason"). Concrete scenario: the 05:35 failure tells the user "will retry at 06:05"; between 05:35 and 06:05 the user's credentials row is removed/corrupt; at 06:05 the retry is claimed, refused, and **nothing is sent** — and the missed-run sweep stays quiet too, because the day's failed run row makes `hasRunToday` true. The user hears "will retry" and then nothing, all day. `already_running` is self-healing (the winning run sends its own outcome message); `no_credentials` is not. Report divergence (5) ("discard notifies on every discard reason") is therefore false as written.

### B4 — **[Low] `already_running` slot retry has an undisclosed user-visible consequence**
Divergence (4) discloses that `already_running` keeps the slot retryable, but not what that produces: a user who clicks "Clock in now" at 05:29 whose run is still **active** at the 05:30 slot now causes the scheduler to re-try every ~15 s until the manual run finishes, at which point a **second** run is created, launches Chromium, hits the already-clocked guard and sends the user a "clock-in skipped" notification. Pre-15, the single `already_running` response wrote the slot off for the day and the user heard nothing. No double-clock risk (the guard reads HRHub before clicking — phase 17 hardens it), but it costs a Chromium launch and a confusing message to the person who deliberately clicked. Worth a deliberate decision rather than a side effect.

### B5 — **[Nit] Report inaccuracies (no code impact)**
- `otp-error-unwrap` listed as updated; its working-tree diff is empty.
- `scheduler-tick.test.ts` has **10** tests (report says 9); `durable-retry.test.ts` has **8** (report says 7).
- `missed-run-sweep.test.ts`, `test/services/notifications.test.ts`, `_journal.json`, `BACKLOG.md` modified but unreported (all legitimate — see A6).
- Observed in passing, **not introduced by this phase**: a malformed JSON body POSTed to an authed route returns 500 rather than 400 (express SyntaxError → generic error handler). Out of scope; noting it so it isn't attributed to phase 15.

### Fault-injection log (each: break → red → restore → full suite green at 262/171)

| # | Probe | Protected test(s) | Result |
|---|---|---|---|
| 1 | `finishRun` retry decision forced to `"none"` | run-lifecycle: executor-backstop, orphan-retry, orphan-past-cutoff | **3 red** ✅ can fail |
| 2 | `claimRetry` WHERE guard removed | durable-retry: concurrent claims | **ALL GREEN — cannot fail** → B1 |
| 3 | `isSlotHandled` → always `true` | scheduler-tick: FAILED-fire retried, already_running retried | **2 red** ✅ can fail |
| 4 | config default `"false"` → `"true"` | config-scheduler-enabled: default/empty-string/fallback | **3 red** ✅ can fail |
| 5 | sweep `hasPendingRetry` → always `false` | durable-retry: alert-suppression-across-restart | **1 red** ✅ can fail |
| 6 | `startRun` clears the wrong Manila day | run-lifecycle: manual-click-supersedes | **1 red** ✅ can fail |

Verified by injection: probes 1, 3, 4, 5, 6. **Not** verified by injection (no failing mutation found/attempted): the orphan-recovery error-text assertion, the executor-failure-backstop registration test, the pause/holiday/cap re-application tests (their code paths are the same `fireClaimedRetry` guards probe 1 exercised), and the 15D `/health` tests (covered instead by the three live boot probes in A4).

---

## C — what I could not verify, and where to look hardest

1. **The from-empty schema diff** (`[manual]` row 1) — still unrun; `0008` sits on the same unverified base as `0005`–`0007`. This gates applying anything to a database holding real credentials. **Reviewer: treat the laptop's `pnpm db:migrate` as blocked on this row.**
2. **The real laptop deploy** — `SCHEDULER_ENABLED=true` in the laptop's `.env`, migration `0008` applied there, boot log + `/health` + the next real slot firing (row 2). I verified the boot gate against `sprout_test` on the work PC only; the laptop's `.env`, containers and DB are unreachable from here.
3. **Real container restarts** — with a retry pending (row 3) and mid-run (row 4). The integration tests simulate a restart in-process (`stopWallClockTick` + re-register); a Docker restart's orphan recovery, the interaction with the real clock and HRHub, and "exactly one clock entry" are not provable from here.
4. **The 15E "twice from cold" claim** — I ran the full suite once clean at exactly the recorded counts; the second cold run and the long-run flakiness absence rest on the implementer's record. One clean run cannot prove "not flaky".
5. **Double-clock safety of an orphan-triggered retry against live HRHub** — the phase's safety argument leans on the already-clocked guard reading HRHub first; that guard's real behaviour is phase 17's problem and is untestable here.
6. **The `already_running` re-try loop over a real 20-minute window** (B4) — log volume, Chromium memory and the actual notification sequence were only observed in unit tests; a human watching one real occurrence would settle whether it is noise or a problem.
7. **Real Telegram delivery** of the changed messages (give-up now carrying the escaped error text; the rewritten missed-run message) — sends were only asserted against a mocked `dispatch`; `escapeHtml(truncateText(stripAnsi(error)))` against a real-world error string with markup is unit-only.
8. **A real DB blip during `scheduleRetryOnFailure`** (B2) — the scenario is reasoned from the code path, not reproduced against a real connection reset.
9. **The `fireCron` "possible holiday" notify-then-proceed path and Gazette behaviour** — Gazette is being removed by phase 16; I verified only the degrade-to-`[]` catch, not live Gazette parsing (consistent with phase 16's removal decision).

---

## D — `[manual]` checks (human only; results column intentionally empty)

Carried forward from the phase file's Verification Gate, plus two additions from this round.

| # | Check | Exact steps | Pass looks like | Results |
|---|---|---|---|---|
| 1 | **From-empty schema diff** (gates everything below) | Restore the latest backup into a scratch DB; in `app/backend` run `pnpm db:migrate` from empty; `pg_dump` the scratch DB and the live `sprout` DB; diff tables, indexes, constraints | Identical, including `runs_one_active_per_user` and the new nullable `runs.retry_at` | |
| 2 | Laptop deploy with the scheduler opted in | On the laptop: set `SCHEDULER_ENABLED=true` in `.env`; `pnpm db:migrate` (applies `0008`); deploy/rebuild the backend; check the boot log and `curl --noproxy '*' http://127.0.0.1:3000/health` | Boot log says `scheduler enabled (SCHEDULER_ENABLED=true) …`; `/health` shows `scheduler.enabled: true`, `lastTickAt` advancing; the next 05:30/16:05 slot produces a `runs` row | |
| 3 | Restart with a retry pending | Wait for (or cause) a failed run with a queued retry; while it is pending, restart the `sprout-backend` container; wait past `retry_at`; then check `runs`, Telegram and `missed_run_notices` | The retry fires after the restart (a new `runs` row, `attempt` +1); exactly one resolution message (give-up or success); **no** duplicate missed-run alert for that day | |
| 4 | Restart during a run | Start a run; restart the container while it is `running`; inspect Telegram, `runs`, and the HRHub attendance card | An "Interrupted by server restart" outcome message and a queued retry; HRHub shows **exactly one** clock entry for that action | |
| 5 | Work PC / second host stays quiet with the key unset | On a host **without** `SCHEDULER_ENABLED` (the work PC dev flow, or a fresh clone): boot the backend; check the boot log, `/health`, and that no `runs` row appears at a scheduled minute | One `scheduler disabled …` log line; `/health.scheduler.enabled: false`, HTTP 200 (not 503); no slot fires | *(my local equivalent against `sprout_test` passed — see A4; this row stays for the human's normal dev workflow)* |
| 6 | **New (from B4):** manual click active at slot time | With a schedule at 05:30, click "Clock in now" at ~05:29 and leave the browser on the dashboard; observe until ~05:35 | Decide whether the second (skipped) run + "clock-in skipped" notification after the manual run completes is acceptable UX, or whether `already_running` should write the slot off for the day | |
| 7 | **New (from B3):** credentials removed between failure and retry | Cause a clock-in failure with notifications on ("will retry at HH:MM" arrives); delete the user's Sprout credentials before the retry time; wait past `retry_at` | Today: silence (the defect). Desired: a give-up/resolution message naming that the retry could not run | |

---

*End of addendum. No source files were modified by this round; all fault probes were restored and the full backend suite re-run green (262 unit / 171 integration) afterwards.*

---
---

# Fix round 1 addendum — B1 + B3 re-test (2026-10-14, same day)

**Tester:** fresh session, fix-round pass, on `DESKTOP-3SV8V8A` (work PC — hostname verified before touching anything). **Scope:** the implementer's claims that B1 (atomic-claim tests that cannot fail) and B3 (silent `no_credentials` discard) are fixed. Method: every gate re-run from scratch; two fault-injection probes (break → red → restore → hash-verified byte-exact + full-suite green); structural review of the changed branch; direct `psql` inspection. **No source change remains:** SHA256 of both touched files identical before probing and after every restore (`retry-state.ts` `258688B6…`, `run-lifecycle.ts` `DC53F80D…`), `git grep "FAULT PROBE"` empty, durable-retry 11/11 and the full integration suite **174/174** re-run green after restoration.

---

## A — what I verified structurally (confirm, don't repeat)

### A0. Gates re-run — counts match the report exactly

| Gate | Result |
|---|---|
| `app/backend pnpm lint` / `pnpm typecheck` | clean (oxlint, tsc) |
| `app/backend pnpm test` | **25 files / 262 tests passed** |
| `app/backend pnpm test:integration` | **30 files / 174 tests passed** (run twice: pre-probe and post-restoration) |
| `app/frontend pnpm lint` / `pnpm build` | clean / built |
| `app/frontend pnpm test` | 1 file / **5 passed** |
| `app/frontend pnpm test:e2e` | **16 passed** |

174 = round-1's 171 + the three new tests. **No count went down.** `docker compose` untouched except `up -d postgres` (already running); live `sprout` DB never written.

### A1. B3 code change — present and shaped as claimed

- `app/backend/src/services/run-lifecycle.ts:450-471` — the `!result.ok` branch splits on `result.reason`: `"no_credentials"` → `logger.info` + `void notifyRetryGiveUp(run)` (same fire-and-forget idiom as the cutoff/cap/rollover discards at `:390`, `:401`, `:412`); `"already_running"` → log line only. `notifyRetryGiveUp` was already imported (`run-lifecycle.ts:16`); the reason union `"no_credentials" | "already_running"` matches `StartRunResult` (`:71-73`).
- No module-ownership violation (rule 9): no new imports beyond what the file already had.

### A2. B1/B3 tests — additive, in the file claimed

- `test/integration/durable-retry.test.ts:290-342` — "two ticks racing the same due retry send exactly one give-up" (clock-out queued 22:50, fired 23:30 past the 23:00 cutoff; `SELECT … FOR UPDATE` on the failed row forces both ticks past `loadDueRetries` before either claim resolves; asserts one give-up, one run row total).
- `:344-364` — "claimRetry is atomic: a second claim of the same row gets nothing" (two direct claims → exactly one row; a later claim → `undefined`).
- `:366-386` — "a claimed retry whose credentials have gone sends exactly one give-up" (queue retry → delete credentials row → fire → one give-up, no attempt-1 run, no pending retry).
- Test count 8 → 11; all eight round-1 tests intact under their original names. Imports gained: `credentials`, `pool`, `claimRetry` — exactly what the report says and nothing more.

### A3. `claimRetry` itself — unchanged from its original atomic form

`app/backend/src/services/retry-state.ts:140-147` is still one `UPDATE … SET retry_at = NULL WHERE id = $1 AND retry_at IS NOT NULL RETURNING …`. The fix round did not touch it (verified structurally and by hash through my own probes).

### A4. Database — no migration generated, nothing new in `drizzle/`

`app/backend/drizzle/` holds `0000`–`0008` only; `_journal.json`'s newest entry is `idx: 8 / tag: 0008_run_retry_at` — unchanged since round 1. `sprout_test`'s `drizzle.__drizzle_migrations` = **9 rows**, newest `created_at 1791941621470` matching the journal. The fix round added no schema change (correct — neither B1 nor B3 needed one).

### A5. LATEST-TECH check (2026-10-14, reaffirms round 1 A7)

**No new dependency was added** (`package.json` / `pnpm-lock.yaml` untouched by the fix — zero new supply-chain surface). Registry re-checked today: zod **4.6.7** (installed ^3.23.8), drizzle-orm **0.45.4** (^0.45.2), express **5.3.0** (^5.1.0), vitest **5.0.4** (installed 4.1.x), pino **10.4.0** (^9.5.0), imapflow **2.4.0** (^1.7.2). Round 1's outdated-dep list is unchanged and correctly *reported, not bumped* (AGENTS.md: no mid-phase upgrades). No deprecated API in the changed code: `void notifyRetryGiveUp(...)` is the project's sanctioned fire-and-forget idiom; the drizzle `update/where/returning` chain is current for the installed 0.45.x (re-confirmed against Context7-era drizzle docs in round 1).

---

## B — defects found (fix-round 1)

### Claims re-evaluated — both CLOSED

**B1 — CLOSED.** Round 1's probe ("remove `AND retry_at IS NOT NULL` → ALL GREEN") now yields **2 red**: the FOR UPDATE test fails with `expected 2 to be 1` (two 🛑 give-ups — precisely the double-message scenario B1 described) and the direct atomic test fails with `expected [row, row] to have a length of 1 but got 2`. I reproduced both reds myself (see the probe log below). The FOR UPDATE construction genuinely forces the interleaving — the probe's redness is the proof, not the comment. The remaining pre-round-2 test (`two concurrent claims … produce exactly one run`) still cannot fail against a non-atomic claim — the partial index absorbs it — but that no longer matters: the suite now contains tests that *do* fail, which was the substance of B1.

**B3 — CLOSED.** The `no_credentials` branch now sends the give-up (`run-lifecycle.ts:463`), and the new test pins it: commenting out the `void notifyRetryGiveUp(run)` call makes "a claimed retry whose credentials have gone sends exactly one give-up" fail with `expected +0 to be 1` — the exact silence of round 1. With the code restored, the test passes and asserts **exactly one** give-up, **no** attempt-1 run row, and **no** lingering `retry_at` (so no second message from any later tick, and the sweep stays suppressed by the day's failed row). The report's own correction is right: the refusal union is `"no_credentials" | "already_running"`, not `not_started`.

### Fault-injection log (this round; each: break → red → restore → hash-verified + green)

| # | Probe | Protected test(s) | Result |
|---|---|---|---|
| 7 | `claimRetry` `AND retry_at IS NOT NULL` guard removed (`retry-state.ts:144`) | durable-retry: *two ticks racing… one give-up* + *claimRetry is atomic* | **2 red** ✅ can fail |
| 8 | `void notifyRetryGiveUp(run)` commented out in the `no_credentials` branch (`run-lifecycle.ts:463`) | durable-retry: *credentials have gone sends exactly one give-up* | **1 red** ✅ can fail |

Restoration proof: both files' SHA256 identical to their pre-probe values; `git grep "FAULT PROBE"` empty; durable-retry 11/11 green; **full integration suite 30 files / 174 tests green** after restore.

### New defects

**BF1 — [Low] A fire-time give-up does not ping the heartbeat — the phase contract says it should.**
Phase file 15A: "ping on success, on a deliberate skip … **and on give-up**"; STATE.md's phase-15 row repeats it. `finishRun` honours that (a failure whose decision is `"give-up"` sets `pinged = true`, `run-lifecycle.ts:228-229`), but **none** of `fireClaimedRetry`'s discard paths ping: day rollover (`:390`), cap (`:401`), cutoff (`:412`) and now `no_credentials` (`:463`) all `void notifyRetryGiveUp(run); return;` with no `d.pingHeartbeat()`. The asymmetry is visible in the same function: holiday/pause *cancellations* (silent to the user) **do** ping (`:425`, `:434`) while give-ups (the louder outcome) do not. Concrete failure scenario: the 16:05 clock-out fails at 22:20 (no heartbeat — retry queued), the process restarts, the restored 22:50 retry is discarded past the 23:00 cutoff with a give-up at 23:30 — the user is messaged, but **no heartbeat has fired since the previous day**, so an outside dead-man's-switch with a sub-26-hour threshold pages "host down" overnight while the app is healthy and the user was told exactly what happened. Pre-existing for cutoff/cap/rollover; the B3 fix's new branch inherits it because it copies the existing pattern. Not BLOCKING (correctness of clocking and messaging is unaffected; the dead-man's-switch still gets its pings on ordinary days). Recommended handling: fold into the B4 decision or a one-line follow-up (`d.pingHeartbeat()` before each discard `return`).

**BF2 — [Low] The `already_running` half of the fixed branch has zero test coverage, and its silence has a cross-action hole.**
Nothing in the suite asserts that `already_running` stays silent or that "the winning run's own outcome is the only message" (`grep already_running` in `test/` hits only `scheduler-tick.test.ts:151`, the *slot* path). The branch comment (`run-lifecycle.ts:466-467`) is an untested claim. Worse, the claim is only true **same-action**: `runs_one_active_per_user` is per **user**, not per user+action (`schema.ts:141-143`), so a manual **clock-out** run active at 06:05 makes a due **clock-in** retry get `already_running`, stay silent, and lose the retry (`retry_at` already nulled by the claim; the day's failed run row keeps the sweep quiet) — the clock-in vanishes with no message at all, the exact class this phase exists to remove. Contrived (needs a cross-action manual run racing the retry fire) and pre-existing (B4 family, not introduced by this fix), so not BLOCKING — but B4's manual row 6 should decide it deliberately rather than by inheritance. Suggested direction (coder's call, a later round): on `already_running`, re-queue `retry_at` a tick-interval later instead of dropping the claim, or assert silence in a test so the invariant is at least pinned.

**BF3 — [Nit] STATE.md still records 171 integration tests; the suite is now 174.**
`rebuild/STATE.md:118` and `:141` both pin "**262 backend unit / 171 backend integration**" and say a suite below that count "is a finding" — the opposite is now true. The report discloses not editing STATE.md and asks the reviewer to fold the number in; per AGENTS.md the ledger update belongs in the same commit as the code, so the reviewer **must** update both lines (and the "fewer than 262 / 171 is a finding" threshold) or the next session inherits a false baseline.

**BF4 — [Nit] The phase file's as-built note 7 is now stale.**
It lists the notifying discard reasons as "past the cutoff, past the cap, and day rollover"; after the B3 fix, `no_credentials` also notifies. No correction note was added (the report doesn't claim one). Reviewer: extend note 7's list when folding in the commit, per AGENTS.md's dated-correction rule.

**B2 — reaffirmed OPEN (accepted in round 1, not claimed fixed here).** `finishRun` still calls `scheduleRetryOnFailure` with no surrounding try (`run-lifecycle.ts:212-215`); a transient DB error at that instant still loses the message. Accepted-with-notes stands; nothing in this round changes it.

### Report-vs-reality diff (fix-round scope)

The named changes are exactly what landed (A1/A2). Files the report says it did **not** touch check out: `rebuild/STATE.md` still says 171 everywhere (BF3), and the phase file's as-built notes carry no fix-round addition (BF4) — both consistent with the report's disclosure. No deferred work leaked in: no phase 16/17 files, `automation/` untouched, no `drizzle/` change, no dependency change.

---

## C — what I could not verify, and where to look hardest

1. **The round-1 → fix-round diff itself.** The entire phase-15 tree is one uncommitted working copy; git cannot split the two rounds, so "ONLY the B1/B3 changes landed" is verified by reading the named code/tests and by the disclosed-not-touched files behaving as disclosed — not by a diff. A stealth edit elsewhere in the tree cannot be excluded by diff alone; the reviewer's fresh re-run and full-diff read is the backstop.
2. **Flakiness of the FOR UPDATE construction.** Its 250 ms pre-COMMIT wait held across three green runs (full suite ×2, isolation ×1) and the probe reliably went red — but one morning of runs cannot prove "never flaky" (same caveat 15E already records).
3. **BF1 against a real `HEARTBEAT_URL` endpoint** over a real overnight window — reasoned from the code path, not reproduced with a live monitor.
4. **Live Telegram delivery of the new `no_credentials` give-up** (real bot, real message rendering with a real-world error string) — asserted only against a mocked `dispatch`. Still `[manual]` row 7.
5. **Everything carried forward from round 1's section C** stands unchanged: the from-empty schema diff (row 1), the real laptop deploy with `SCHEDULER_ENABLED=true` + migration `0008` (row 2), real container restarts with a retry pending / mid-run (rows 3–4), the `already_running` re-try loop over a real 20-minute window (row 6), and double-clock safety against live HRHub (phase 17's problem).

---

## D — `[manual]` checks (human only; results column intentionally empty)

Carried forward from round 1 — all seven rows unchanged; row 7's pass condition is now the *fixed* behaviour. BF1 adds no new row (it is covered by observing row 3's outcome sequence with a real monitor attached).

| # | Check | Exact steps | Pass looks like | Results |
|---|---|---|---|---|
| 1 | **From-empty schema diff** (gates everything below) | Restore the latest backup into a scratch DB; in `app/backend` run `pnpm db:migrate` from empty; `pg_dump` the scratch DB and the live `sprout` DB; diff tables, indexes, constraints | Identical, including `runs_one_active_per_user` and the new nullable `runs.retry_at` | |
| 2 | Laptop deploy with the scheduler opted in | On the laptop: set `SCHEDULER_ENABLED=true` in `.env`; `pnpm db:migrate` (applies `0008`); deploy/rebuild the backend; check the boot log and `curl --noproxy '*' http://127.0.0.1:3000/health` | Boot log says `scheduler enabled (SCHEDULER_ENABLED=true) …`; `/health` shows `scheduler.enabled: true`, `lastTickAt` advancing; the next 05:30/16:05 slot produces a `runs` row | |
| 3 | Restart with a retry pending | Wait for (or cause) a failed run with a queued retry; while it is pending, restart the `sprout-backend` container; wait past `retry_at`; then check `runs`, Telegram and `missed_run_notices` | The retry fires after the restart (a new `runs` row, `attempt` +1); exactly one resolution message (give-up or success); **no** duplicate missed-run alert for that day | |
| 4 | Restart during a run | Start a run; restart the container while it is `running`; inspect Telegram, `runs`, and the HRHub attendance card | An "Interrupted by server restart" outcome message and a queued retry; HRHub shows **exactly one** clock entry for that action | |
| 5 | Work PC / second host stays quiet with the key unset | On a host **without** `SCHEDULER_ENABLED` (the work PC dev flow, or a fresh clone): boot the backend; check the boot log, `/health`, and that no `runs` row appears at a scheduled minute | One `scheduler disabled …` log line; `/health.scheduler.enabled: false`, HTTP 200 (not 503); no slot fires | *(round-1 local equivalent against `sprout_test` passed — A4 of round 1; this row stays for the human's normal dev workflow)* |
| 6 | Manual click active at slot time (B4 — now also BF2's cross-action variant) | With a schedule at 05:30, click "Clock in now" at ~05:29 and leave the browser on the dashboard; observe until ~05:35. Then repeat with the *opposite* action active at the retry's fire time (e.g. a manual clock-out open when a clock-in retry is due) | Decide whether the second (skipped) run + "clock-in skipped" notification after the manual run completes is acceptable UX, and whether a cross-action `already_running` swallowing a retry silently is acceptable or must re-queue | |
| 7 | Credentials removed between failure and retry (B3 — now code-correct) | Cause a clock-in failure with notifications on ("will retry at HH:MM" arrives); delete the user's Sprout credentials before the retry time; wait past `retry_at` | **One** give-up/resolution message naming that the retry could not run (the round-1 defect was silence; the code now sends it — this row confirms real Telegram delivery) | |

---

*End of fix-round-1 addendum. No source files were modified by this round; both fault probes were restored byte-exact (SHA256-verified), and the full backend suite was re-run green afterwards (262 unit / 174 integration, frontend 5 / e2e 16).*
