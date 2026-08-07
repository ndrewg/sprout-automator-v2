# Phase 7 — review addendum

Hand to the reviewer alongside the implementer's Handoff report, or just point it at this file.

---

## A. Pre-review structural check (done by the human's session — confirm, don't redo)

- Migration `0002_pause.sql` is minimal and correct: two nullable `date` columns, no data migration, no index churn.
- `isPausedOn` (`lib/ph-holidays.ts:45`) matches spec: both-null guard, inclusive `>=` / `<=`, plain ISO string comparison — no `Date` arithmetic, no timezone traps.
- All three required call sites present: `scheduler.ts:120` (`fireCron`), `notifications.ts:329` (missed sweep), `schedule.ts:62` (`pausedToday`, computed server-side).
- **`services/runs.ts` and `routes/runs.ts` are untouched** — the correct signal that manual runs are not blocked while paused.

## B. Review focus

1. **Boundary correctness on `isPausedOn`.** Six cases must be covered by tests and each must be able to fail: day before / first day / middle / last day / day after / both-null. The last day being *inclusive* is the one an off-by-one would silently break, and it would only show up as "my leave ended and it clocked me in a day early" — or worse, a day late.
2. **The sweep call site is the subtle one.** `notifications.ts:329` `continue`s past paused users. Verify the `continue` sits *before* the notice-row insert, not after — inserting a `missed_run_notices` row and then skipping the send would burn that day's slot silently, and the row would block a legitimate alert if the pause were cleared later the same day.
3. **Validation on `PUT /schedule`**: both dates or neither (one alone → 400), `pausedUntil >= pausedFrom`, and `pausedUntil` not already in the past. Each with a test.
4. **Server-authoritative dates.** The UI must not compute Manila dates in the browser — `pausedToday` comes from the server, and "Skip tomorrow" derives from `schedule.today.date`, not `new Date()`. A colleague travelling would otherwise skip the wrong day.
5. **`reference/api-contract.md` was updated** for the new `ScheduleView` fields. Verify it matches the actual response shape and the frontend type in `api.ts` — all three must agree.
6. **Audit:** `schedule_updated` metadata should carry `pausedFrom`/`pausedUntil` **values** (these are not secrets, unlike credentials fields).
7. `missed-run-sweep.test.ts` covered only clock-in before phase 6's last round. Confirm the new pause cases cover **both** actions.

8. **Spec inconsistency found while planning the manual tests (my error, not the implementer's).** Gate 7B says to verify auto-expiry by *"setting a range ending yesterday"* — but 7A's validation explicitly rejects a `pausedUntil` in the past (`"That pause window has already ended."`). The two cannot both hold, so auto-expiry is untestable through the API by design. That is the correct behaviour to keep — setting an already-expired window is always a typo — so **fix the gate, not the validation**: verify auto-expiry with a direct DB update (`update schedules set paused_until = <yesterday>`), then `GET /schedule` and confirm `pausedToday` is false. Correct the wording in `phase-7-schedule-pause.md` § 7B.

9. **The migration was generated but never applied to the dev database — and every gate stayed green.** `pnpm dev` crashed on boot with `column "paused_from" does not exist` (in `loadAllSchedules`), while `pnpm typecheck`, `pnpm test` and `pnpm test:integration` all passed, because the integration suite migrates **`sprout_test`** and never touches `sprout`.
    **This is a structural gap in the gate design, not implementer error.** Any phase with a migration can pass every automated check and still leave the developer's app unbootable — and the failure appears later, disconnected from the change, looking like data loss (it presented as "did my password get reset?").
    **Fix:** add applying the migration to the dev database as an explicit step in any phase that generates one, and to `reference/testing-strategy.md` as a known blind spot:
    `pnpm exec tsx --env-file=../../.env src/db/migrate.ts`
    Consider a cheap guard — a startup log line naming the latest applied migration, or a `[manual]` gate item "`pnpm dev` boots after the migration" for any phase touching the schema.

## C. Ledger updates required in this commit

- `STATE.md`: move pause/leave from "Not built" to "Built and verified"; update "Suggested order from here" so 4A.2 signup gating is next.
- Note in the phase-7 file if reality diverged (dated as-built note).
- **Do not create a tag.**

## D. `[manual]` check results (human-run)

| # | Check | Result |
|---|---|---|
| 1 | Pause covering today → banner appears in SchedulePanel | ✅ "Auto-runs are paused until 07 Aug. You can still clock in manually." |
| 2 | "Skip tomorrow" sets both dates to tomorrow's **Manila** date | ✅ both fields → `08/08/2026`; banner correctly disappeared, since the window no longer covers today |
| — | Incidental: cron fired to the second on an unpaused day, the guard skipped it, and Telegram delivered ℹ️ with the correct matched-row reason — phase 6 defect 12 re-confirmed on live data | ✅ |
| — | Incidental: a missed clock-out alert on an unpaused day rendered **"Clock out manually if you haven't already"** — phase 6 **defect 20** fix confirmed live (it previously said "Clock in" for every action) | ✅ |
| 3 | While paused, a scheduled fire creates **no run** | ⬜ |
| 4 | While paused, **no missed-run 🔴 alert** is sent | ✅ first half — silence across >1 sweep with the ledger empty for today. **`missed_run_notices` stayed at 0 rows**, which externally confirms review item 2: the `continue` for paused users sits *before* the notice insert, so a paused day does not burn the day's slot. Second half ✅ — cleared the pause, 🔴 arrived on the next sweep (19:50), proving the pause was the cause of the silence rather than a poisoned ledger or a dead sweep |
| 5 | While paused, a **manual** "Clock in now" still works | ✅ run created at 07:51:36 with the pause active and the banner showing; ended `skipped` via the already-clocked guard. Manual intent correctly overrides the pause |
| 6 | Clearing the pause restores normal operation | ✅ banner gone, both date fields cleared, clock-in/out and the enabled flag untouched |
| 7 | A window ending yesterday auto-expires (`pausedToday` false, no clearing needed) | ✅ set `2026-08-05` → `2026-08-06` directly in the DB (the API correctly refuses a past `pausedUntil` — see item 8); dashboard showed both dates stored with **no banner**. The window lapsed with no user action |
| 3 | While paused, a scheduled fire creates **no run** | ✅ clock-in set to 07:59 PM with the pause covering today; nothing fired. (First attempt was invalid — "Skip tomorrow" had moved the window to `08/08`, so today was not paused and the cron correctly fired; retried properly afterwards.) |
