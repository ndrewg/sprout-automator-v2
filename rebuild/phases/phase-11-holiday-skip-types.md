# Phase 11 — Holiday skip types (a live defect)

**Goal:** stop clocking people in on Philippine special non-working days. One wrong filter is doing it today.

> ⏰ **Deadline: 2026-08-21.** The next day this defect misfires is **Ninoy Aquino Day**. If nothing else in the queue moves this week, this must.

**Attach for this session:** `03-CONVENTIONS-AND-GUARDRAILS.md`, `02-DECISIONS-AND-ARCHITECTURE.md` (§ holidays), `phases/phase-7-schedule-pause.md` (the pause window this must not duplicate), `reference/testing-strategy.md`.

> 📡 **Fetch live docs (Context7):** `date-holidays` — the `type` taxonomy and the `isHoliday` return shape. Do not write these from memory.

**Scope.** Filter, return type, notification, tests. The layered sourcing work — operator overrides and the Official Gazette — is **phase 13** and must not be started here.

---

## The defect

A real scheduled run clocked the operator in on a holiday in August 2026. **The wiring was never the problem** — `services/scheduler.ts:106` calls `isPhilippineHoliday(now)` and returns early on a hit. The filter is:

```ts
// lib/ph-holidays.ts:11
const SKIP_TYPES = new Set(["public", "bank"]);
```

`date-holidays` classifies Philippine **special (non-working) days** as **`optional`**. Verified against the installed version for 2026:

```
2026-02-17 | optional | Chinese New Year
2026-08-21 | optional | Ninoy Aquino Day        <-- next miss
2026-11-01 | optional | All Saints' Day
2026-11-02 | optional | All Souls' Day
2026-12-08 | optional | Immaculate Conception
2026-12-24 | optional | Christmas Eve
2026-12-31 | optional | New Year's Eve
```

**Eight days in 2026 are treated as ordinary workdays.** The operator does not work them.

Two pieces of dead scaffolding sit alongside it: `isYearCovered()` (`ph-holidays.ts:54`) returns `true` unconditionally and is called by nothing — a staleness guard hardcoded to "fine"; and `EXTRAS` (`ph-holidays.ts:6`) is a commented-out override map that needs an image rebuild to change. Phase 13 replaces `EXTRAS`; this phase deals with `isYearCovered`.

## The principle

**Clocking in on a day you did not work is a false payroll record. Failing to clock in is a button press plus an alert you already get.** The costs are not symmetric, so **fail safe means skip** — and a skip whose basis is less than certain must **notify**, so a wrong skip costs one click that morning rather than surfacing at payroll.

---

## 11A — Widen the filter and report the type

**Contract:**
- Add `optional` to `SKIP_TYPES`.
- **`isPhilippineHoliday` returns the type, not just a name.** It is `string | null` today (`ph-holidays.ts:17`); widen it to `{ name: string; type: string; source: "library" | "override" } | null` so callers can tell a regular holiday from a special non-working day. Update all three call sites: `services/scheduler.ts:106`, `routes/schedule.ts:37`, `services/notifications.ts:280`.
- Keep the existing `EXTRAS` short-circuit working — phase 13 replaces it, and leaving it half-migrated between phases is worse than either state.
- **Delete `isYearCovered()`.** A guard that cannot fail is worse than no guard, and nothing calls it. If a real staleness check is wanted, phase 13 is where it belongs.
- Do **not** touch `isPausedOn` or the pause window. That is one person's leave (phase 7); this is a day that affects everyone.

**Tests (unit, injected clock — no exceptions):**
- `2026-08-21` (optional) skips. `2026-12-25` (public) skips. `2026-06-19` (observance) does **not** skip. An ordinary Tuesday does not skip.
- The returned `type` is correct for each, so a caller can branch on it.
- **Every fixture passes its own `now`.** A test that reads the wall clock is the next date time-bomb — `missed-run-sweep` did exactly that on 2026-08-11 (`BACKLOG.md` § 11).

**Gate 11A:** `cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration`

---

## 11B — Notify on a special-non-working skip

**Contract:**
- When a skip is caused by an **`optional`** holiday, send one Telegram: which holiday, that it is a special non-working day, and that **"Clock in now"** is there if they are working after all.
- **A `public` skip stays silent.** Nobody needs a Christmas Day message, and a channel that fires on every predictable holiday is a channel people mute — at which point it cannot warn them about anything.
- **⚠️ There is no run row to attach this to.** `fireCron` returns at `scheduler.ts:112` *before* anything is inserted into `runs`, so this cannot reuse the run-finished dispatch in `services/notifications.ts`. It needs its own send path.
- **It must be idempotent.** A container restart, or the second cron fire of the same day (`in` then `out`), must not produce duplicate messages. Use the same "let the database decide" pattern as the missed-run notices (D17): insert a row keyed on `(user_id, manila_date, action)` and send only if the insert won. **Do not hold state in memory** — the process restarts.
- Fire-and-forget: a dead Telegram endpoint must not change the skip decision or delay anything (AGENTS.md rule 11), asserted by a test modelled on `notification-isolation.test.ts`.
- New migration if a notice table is needed. **Never edit a committed migration.**

**Tests (integration):**
- The notification fires for `optional` and **not** for `public`.
- A second dispatch for the same user, Manila date and action is suppressed.
- A failing Telegram endpoint does not affect the skip.

**Gate 11B:** `cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration`

---

## Verification Gate (the whole phase)

```
cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration
```

Baselines: **161 backend unit / 106 backend integration.** Higher is expected; lower is a finding.

**`[manual]` — must not be claimed as passed:**

| # | Check | Pass looks like |
|---|---|---|
| 1 | **2026-08-21 (Ninoy Aquino Day), real scheduled run** | **No clock-in.** A Telegram naming it a special non-working day and mentioning "Clock in now" |
| 2 | A `public` holiday (e.g. 2026-11-30 Bonifacio Day) | Skipped **silently** — no Telegram |
| 3 | Restart the container on a holiday after the notice was sent | No duplicate message |

Row 1 is the whole point and can only be checked on the day. Commit per the loop in `AGENTS.md`; tag `phase-11-complete` when the table is filled in.
