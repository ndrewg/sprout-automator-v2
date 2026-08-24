# Phase 14 — Tester Addendum

## A. Gate re-run results

All gates re-run from the implementer's uncommitted working tree.

### Backend
```
$ cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration

$ oxlint
$ tsc --noEmit
$ vitest run --project unit
 Test Files  21 passed (21)
      Tests  225 passed (225)

$ vitest run --project integration
 Test Files  27 passed (27)
      Tests  150 passed (150)
```
**225 unit / 150 integration** — both match the report exactly.

### Frontend
```
$ cd app/frontend && pnpm lint && pnpm test && pnpm build && pnpm exec playwright install chromium && pnpm test:e2e

$ oxlint
$ vitest run
 Test Files  1 passed (1)
      Tests  5 passed (5)
$ tsc -b && vite build   (success)
$ playwright test
  16 passed (13.1s)
```
**5 frontend unit / 16 e2e** — matches the report.

### Compose + Drizzle
```
$ docker compose config 2>&1 | Select-String "is not set" | Measure-Object | Select-Object -ExpandProperty Count
0
```
**0 "is not set" warnings** — matches the report.

```
$ cd app/backend && npx drizzle-kit check
Everything's fine 🐶🔥
```

---

## B. Findings

### B1 — `.gitignore` stray `logs_86137047854/` (non-blocking, pre-existing)

**Evidence:** `git diff .gitignore` shows a new line `+logs_86137047854/`. This change is NOT listed in the Handoff report's "What I changed" section.

**Assessment:** This is NOT from phase 14. It was flagged in the phase-10 addendum (B2), phase-12 addendum (B-Something), and phase-13 addendum (B-something) as a pre-existing stray directory. The line has been carried forward through each session's uncommitted working tree without being committed. It is harmless (the directory is properly gitignored and was never tracked), but it clutters every `git diff` and should either be committed or dropped. Non-blocking.

### B2 — No BLOCKING findings

The implementation is architecturally sound. Every critical invariant I probed holds:

1. **`skipped` → ZERO retries (the hard constraint):** Two layers of defense, both tested. Layer 1: `finalizeRun` (runs.ts:105) only calls `scheduleRetryOnFailure` when `patch.status === "failure"`. Layer 2: `scheduleRetryOnFailure` (retry.ts:250) returns `"none"` if `run.status !== "failure"`. The wiring test (retry-wiring.test.ts:73) proves `scheduleRetryOnFailure` is never called for skipped; the integration test (retry.test.ts:223) proves even if called directly, it schedules nothing. Both layers would fail if their guards were removed.

2. **Partial unique index (23505) never 500s:** `attemptRun` (retry.ts:206-212) catches `isUniqueViolation(err)` and cancels the retry silently. Integration test (retry.test.ts:408) proves exactly one active run survives a collision, no error.

3. **Notification discipline is exact:** Code logic in `scheduleRetryOnFailure` (retry.ts:283) sends the "will retry" message only when `run.attempt === 0`. Intermediate retries return `"retry"` without sending. Terminal give-up fires one message when `nextAttempt` returns null and `run.attempt >= 1`. The standard ⚠️ is suppressed when outcome is `"retry"` or `"give-up"` (runs.ts:104-108). Verified in the cap-holds integration test (retry.test.ts:263) which asserts 1 scheduling + 0 intermediate + 1 give-up.

4. **`failRunFromExecutor` keeps its ⚠️:** This function (run-queue.ts:20-52) calls `notifyRunFinished` directly, bypassing `finalizeRun` entirely — so `scheduleRetryOnFailure` is never invoked for this-stack failures. The executor-failure-backstop test (executor-failure-backstop.test.ts:155) proves a queue-level rejection still fires a Telegram notification.

5. **Boot guard for bad cutoffs:** Config-defaults.test.ts (line 78-91) proves `loadConfig()` throws when `RETRY_CLOCKIN_CUTOFF` is `"noon"`, `"25:00"`, or `"12:60"`, naming the key and the error.

6. **Cutoff is independent of the cap:** Unit test (retry.test.ts:89) with a 180-minute interval proves no retry past the 12:00 cutoff even though attempts remain. Integration test (retry.test.ts:316) confirms with a real DB insert.

7. **Module ownership clean:** `retry.ts`, `retry-registry.ts`, `runs.ts`, `scheduler.ts` do NOT import `lib/telegram`. Dispatch flows through `services/notifications.ts` via `dispatch()`. `date-holidays` remains in `lib/ph-holidays.ts`. No new npm dependencies.

8. **Phase 13 features intact:** `HEARTBEAT_URL` and `EXTRA_HOLIDAYS` remain in `config.ts`, `.env.example`, and both compose files. The diff shows the RETRY_* keys appended AFTER the EXTRA_HOLIDAYS entry.

### B3 — Test leak edge case (non-blocking, informational)

The `executor-failure-backstop.test.ts` test "a decryption failure triggers the safety net" now routes through `finalizeRun` → `scheduleRetryOnFailure`, which schedules an in-memory retry. This retry fires via node-cron after 30 minutes. The test does not call `clearPendingRetries()` in its teardown. The retry will fire against a torn-down test DB (the user/credentials will have been deleted by `resetDatabase` in the next test's `beforeEach`). `attemptRun` catches all errors (retry.ts:215-217), so this silently fails. With serial integration tests (`maxWorkers: 1`), the timing is safe — no interference. However, a future change to parallel integration tests could surface this as a flaky failure. Non-blocking; note for later cleanup.

---

## C. What I could not verify

These items require a human environment or live system and cannot be confirmed from this session.

### From the phase file `[manual]` table (7 rows):

| # | Check | Command / action | What pass looks like |
|---|---|---|---|
| 1 | Point `SPROUT_URL` at an unreachable host, let a scheduled run fire | Set `SPROUT_URL` to an invalid host in `.env`, wait for cron fire | Run marked `failure`; **one** Telegram naming the next attempt time |
| 2 | Restore `SPROUT_URL` before the next attempt | Revert `.env`, wait for retry fire | The retry succeeds; **one** success Telegram; no further attempts |
| 3 | Leave it unreachable for the whole window | Keep bad `SPROUT_URL` for all N attempts | Exactly N attempts, then **one** give-up message. No message per attempt |
| 4 | Fail a run, then click "Clock in now" manually and succeed | Manually trigger clock-in after a failure | Pending retry cancels; no further attempts |
| 5 | Fail a run, then set a pause window covering today | Add a pause window via the dashboard | The queued retry does not run |
| 6 | Force a `skipped` run (already clocked in) | Clock in manually, then let the scheduled fire run | **No retry scheduled at all** — the constraint that protects against double-clocking |
| 7 | Check the runs table after a retry sequence | `docker compose exec postgres psql -U sprout -d sprout -c "SELECT attempt, status FROM runs ORDER BY started_at"` | `attempt` increments; one row per attempt; no orphaned `running` rows |

### Additional human-only items:

| Item | Notes |
|---|---|
| Apply migration `0007_magenta_zarek.sql` to dev `sprout` DB | `sprout_test` has both columns (confirmed). `sprout` dev DB does NOT — verified by `\d runs` / `\d users`. |
| Restart-drops-retries limitation | In-memory registry means app restart drops pending retries. If a retry is dropped, `hasPendingRetry` returns false on the next sweep, so the now-unsuppressed failed run COULD produce a missed-run alert (minor double-signal vs the "suppress while pending" intent). This is a documented limitation, not a defect — the phase file states it explicitly. |
| Live Telegram notification count | Verify exactly 1 scheduling + 0 intermediate + 1 give-up message arrive in a real Telegram conversation during a retry sequence. |
