# Phase 7 — Pause / Leave Days

**Goal:** stop the automation from clocking you in on days you are not working.

Small phase, real problem. Today the only days the system skips are weekends and PH public holidays. Approved leave, a half-day, a company shutdown, an offsite, resignation notice period — on all of those it clocks you in anyway. That is not a missed convenience, it is a **wrong attendance record** that someone in HR has to unwind, and it is the first thing a colleague will ask for.

**Attach for this session:** `03-CONVENTIONS-AND-GUARDRAILS.md`, `reference/api-contract.md`, `reference/database-schema.md`, `reference/testing-strategy.md`.

**Depends on:** nothing. Sits naturally after Phase 6 because a paused day should not fire a "missed run" alert — that wiring is called out below.

> **Commit checkpoints:** Gate 7A → `feat(phase-7): schedule pause window + skip logic [gate 7A]`; Gate 7B → `feat(phase-7): pause controls in schedule panel [gate 7B]`. Then `git tag phase-7-complete`.

---

## 7A — Backend

### Schema

Two nullable columns on `schedules` — a **closed date range**, not a boolean:

```ts
pausedFrom: date("paused_from"),   // YYYY-MM-DD, Manila calendar day, inclusive
pausedUntil: date("paused_until"), // inclusive
```

A boolean "paused" flag is the obvious design and it is wrong: someone pauses for leave, forgets to unpause, and silently stops clocking in for a month. A date range **expires on its own**, which is the behaviour you actually want. Both columns are set and cleared together; one set without the other is invalid input.

Use Drizzle's `date` type (import from `drizzle-orm/pg-core`), not `timestamp`. These are Manila calendar days, not instants — the same reasoning as `missed_run_notices.manilaDate`.

### The check

One helper, one place, so it cannot drift:

```ts
// src/lib/ph-holidays.ts — lives here because it is the "should we skip today?"
// module and already owns manilaDateString(). Do NOT add date-holidays imports
// elsewhere; this is the same ownership rule.
export function isPausedOn(
  row: { pausedFrom: string | null; pausedUntil: string | null },
  date: Date = new Date(),
): boolean {
  if (!row.pausedFrom || !row.pausedUntil) return false;
  const today = manilaDateString(date);
  return today >= row.pausedFrom && today <= row.pausedUntil;
}
```

ISO `YYYY-MM-DD` strings compare correctly with `<=`/`>=` lexicographically — that is the whole reason for storing them in this format. No Date arithmetic, no timezone traps.

### Wiring — three call sites, all of them

1. **`fireCron`** (`services/scheduler.ts`) — after the holiday check, before `startRun`. Load the user's schedule row, and if `isPausedOn(row)` log and return. No run row is created, exactly like a holiday.
2. **`sweepMissedRuns`** (Phase 6) — skip paused users. A paused day is not a missed run, and alerting on it would train the user to ignore the alerts.
3. **`GET /schedule`** — surface it so the UI can say so (below).

Manual runs are **not** blocked by a pause. If you click "Clock in now" while paused you meant it — perhaps the leave got cancelled. Pausing suppresses *automation*, not intent.

### API

`ScheduleView` gains:

```ts
pausedFrom: string | null,
pausedUntil: string | null,
pausedToday: boolean,        // computed server-side; the UI must not recompute Manila dates
```

`PUT /schedule` accepts `pausedFrom` / `pausedUntil` (`.strict()`, `/^\d{4}-\d{2}-\d{2}$/`, nullable). Validation:
- Both present or both `null` — one alone → `400 "Provide both pausedFrom and pausedUntil, or neither."`
- `pausedUntil >= pausedFrom` → else `400`.
- `pausedUntil` not in the past → else `400 "That pause window has already ended."` (Setting an already-expired window is always a typo.)

Audit `schedule_updated` with `pausedFrom`/`pausedUntil` — these are not secrets, log the values.

**Gate 7A:** unit tests for `isPausedOn` (before / first day / middle / last day / after / null columns — boundaries are inclusive on both ends, assert all six); `fireCron` creates no run while paused; `sweepMissedRuns` sends nothing while paused; one-sided and reversed ranges are `400`; a manual `POST /runs` still works while paused.

---

## 7B — Frontend

In `SchedulePanel`, below the time inputs:

- Two `type="date"` inputs (**Pause from** / **until**) plus a **Clear pause** button.
- A quick action — **"Skip tomorrow"** — that sets both dates to tomorrow's Manila date. This is the common case and it should be one click, not two date pickers.
- When `pausedToday` is true, an `Alert` at the top of the panel: *"Auto-runs are paused until 14 Aug. You can still clock in manually."* Same visual treatment as the existing PH-holiday banner so the two read as one family of "nothing will happen today" states.
- `save()` is async → `await updateSchedule.mutateAsync(...)` in `try/catch` (⭐ the mutation rule).

Tomorrow's Manila date must come from the server (`schedule.today.date` + 1 day is fine to compute client-side from that string; do **not** use the browser's local date — a colleague travelling puts the browser in the wrong timezone and skips the wrong day).

**Gate 7B:** set a pause covering today → banner appears, and the next scheduled fire creates no run; "Skip tomorrow" sets both dates correctly; clearing restores normal operation; the window auto-expires without user action (update the DB directly to set `paused_until` to yesterday — the API correctly rejects past windows — then `GET /schedule` and verify `pausedToday` is false).

---

> ⚠️ **As-built (found 2026-08):** Gate 7B initial wording ("set a range ending yesterday → `pausedToday` false") was inconsistent with the validation layer, which correctly rejects `pausedUntil` in the past. Corrected the gate to instruct direct DB update instead (as shown in the integration test). No code change — validation is correct.

## Deliberately out of scope

- **Half-days.** A half-day is "clock in normally, clock out early" — that is a per-day *time override*, a different feature. If it comes up, it belongs in a `schedule_overrides` table, not here.
- **Recurring pauses** (e.g. every Friday). Cron already handles weekly patterns; if someone works a 4-day week, that is a schedule change.
- **Syncing leave from an HR system.** Requires an API Sprout does not expose to us.
