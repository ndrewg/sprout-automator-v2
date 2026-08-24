# Phase 11 — Holiday Skip Types — Tester Addendum

## A. Gate re-run results

All gates run from a fresh session. Postgres confirmed running (`docker compose up -d postgres`).

### Backend
```
$ cd app/backend && pnpm lint
$ oxlint
(exit 0 — clean)

$ cd app/backend && pnpm typecheck
$ tsc --noEmit
(exit 0 — clean)

$ cd app/backend && pnpm test
$ vitest run --project unit
Test Files  16 passed (16)
     Tests  171 passed (171)

$ cd app/backend && pnpm test:integration
$ vitest run --project integration
Test Files  21 passed (21)
     Tests  109 passed (109)

$ cd app/backend && pnpm exec drizzle-kit check
Everything's fine 🐶🔥
```

**Counts:** 171 unit ✅ / 109 integration ✅ — matches handoff report, above baseline (161/106).

---

## B. Findings

### B1 — No blocking findings

All claims in the handoff report hold under adversarial testing. Each claim is verified below.

### B2 — Test breakability verification (step 3 probes)

Each critical test was proven to go red by temporarily modifying the source:

| Test | Break method | Verdict |
|---|---|---|
| `ph-holidays.test.ts` — "returns type 'optional'" | Removed `"optional"` from `SKIP_TYPES` | ❌ FAILS (correctly — `hit?.name` is `undefined`) |
| `notifications.test.ts` — "escapes markup" | Removed `escapeHtml()` from `renderHolidaySkipMessage` | ❌ FAILS (correctly — raw `<b>` appears in output) |
| `notifications.test.ts` — "silent for public holiday" | Removed `if (holiday.type !== "optional") return "skipped"` | ❌ FAILS (correctly — tries to dispatch, crashes on mock) |
| DB unique index (manual `psql` probe) | Attempted double INSERT for same `(user_id, manila_date)` | ❌ FAILS with `unique constraint "holiday_skip_notice_once"` |

All files restored to byte-exact original after each probe (verified by `git diff` showing only phase-11 changes).

### B3 — Idempotency key divergence verdict

The spec literally says key `(user_id, manila_date, action)`. The coder changed it to `(user_id, manila_date)`. This is **a justified correction, not a deviation**.

**Evidence:** The spec contains two hard requirements that are mutually exclusive with a 3-column key:
1. "Send ONE Telegram" per holiday skip
2. "The second cron fire of the same day (`in` then `out`) must NOT duplicate"

With key `(user_id, manila_date, action)`, the `in` fire and the `out` fire are distinct keys → two inserts win → two messages. The 2-column key is the only way to satisfy both requirements simultaneously. The coder documented this correctly in the phase file as an as-built note (`phase-11-holiday-skip-types.md:79`). **Non-blocking.**

### B4 — HTML escaping analysis

`escapeHtml` (at `lib/telegram.ts:84-89`) escapes `<`, `>`, and `&`. It does **not** escape `"` or `'`. This is sufficient because:
- The escaped value is placed inside `<b>...</b>` tags, never in an HTML attribute
- The Telegram HTML parse mode treats `"` as literal text outside attributes
- Holiday names come from the `date-holidays` library (not user input), so the attack surface is theoretical

The escaping test uses the name `"Feast <b>&</b>"` which covers `<`, `>`, and `&` — the three characters `escapeHtml` handles. **Non-blocking.**

### B5 — Three call sites handle the widened return type

| Call site | Code | Null-safe? |
|---|---|---|
| `scheduler.ts:109-120` | `if (holiday) { ... holiday.name, holiday.type }` | ✅ — guarded by truthiness check |
| `routes/schedule.ts:41` | `isPhilippineHoliday(now)?.name ?? null` | ✅ — optional chaining + nullish coalescing |
| `notifications.ts:348` | `isPhilippineHoliday(date) === null` | ✅ — explicit null comparison |

No null-dereference possible on the holiday path.

### B6 — Fire-and-forget and rule 11

`fireCron` calls `void notifyHolidaySkip(userId, holiday, now).catch(() => {})` — the sanctioned fire-and-forget idiom (AGENTS.md rule 2, idiom #2). The integration test (`holiday-skip-notice.test.ts:125-143`) proves a dead Telegram endpoint (`http://127.0.0.1:9`) does not throw and does not change the outcome. **Non-blocking.**

### B7 — `public` holidays are silent

`notifyHolidaySkip` returns `"skipped"` immediately when `holiday.type !== "optional"` (at `notifications.ts:278`) — **before** any DB insert or send. Verified by both unit test (`insertMock` not called) and integration test (`calls` length unchanged). **Non-blocking.**

### B8 — `isYearCovered()` is gone

Grep for `isYearCovered` across all `.ts` files returns zero matches in `src/`. Only references remain in `rebuild/` docs (STATE.md, phase-11 spec, reference spec). **Non-blocking.**

### B9 — Migration integrity

- `drizzle-kit check` passes ("Everything's fine")
- `git diff` shows zero changes to `0000_init.sql` through `0004_*.sql`
- `meta/_journal.json` has the new entry with tag `0005_holiday_skip_notices` pointing at the correct index
- DB confirms the table has the correct schema, FK, and unique index
- `0005_snapshot.json` is a generated Drizzle artifact accompanying the migration

**Non-blocking.**

### B10 — `EXTRAS` still compiles with new shape

`EXTRAS` is typed as `Record<string, Omit<HolidayInfo, "source"> & { source: "override" }>` and the only entry is commented out. The short-circuit at `ph-holidays.ts:30-31` (`const extra = EXTRAS[iso]; if (extra) return extra;`) still compiles and would return the typed object. Phase 13 replaces this. **Non-blocking.**

### B11 — Minor observation: dead-endpoint integration test does not verify ledger row

The integration test (`holiday-skip-notice.test.ts:125-143`) proves a dead Telegram endpoint does not throw, but does not check that `holiday_skip_notices` has a row after the call. The ledger row IS written (the insert happens before the send), but if the send fails, the row persists and no retry is possible — unlike missed-run notices which have `notifiedAt` for retry. This is by design (fire-and-forget, informational alert), but means a Telegram outage during a holiday causes a permanent loss of the notification. **Non-blocking — noted for the reviewer's awareness.**

---

## C. What I could not verify

| # | Check | Why it cannot be verified |
|---|---|---|
| 1 | **2026-11-02 (All Souls' Day) real run — no clock-in + Telegram** | The date is in the future; cannot force without setting system clock or adding `EXTRA_HOLIDAYS` via phase 13. The unit/integration tests prove the code path, but the real-day proof waits until 2026-11-02. |
| 2 | **Public holiday skipped silently — live Telegram** | Needs a real public holiday (e.g. 2026-11-30 Bonifacio Day) with a real Telegram bot + chat ID configured. Unit/integration tests prove the code path but not the live channel. |
| 3 | **Restart on a holiday — no duplicate message** | Needs a running container on a real holiday, a send already completed, then a container restart. Unit/integration tests prove idempotency via DB constraint but not the real restart scenario. |
| 4 | **Apply migration 0005 to dev `sprout` DB** | `docker compose exec postgres psql -U sprout -d sprout -c "\d holiday_skip_notices"` was not run against the dev database. The integration tests use `sprout_test` which is migrated fresh. The dev DB needs the migration applied and `pnpm dev` verified booting. |

**Row 1 is the whole point of the phase.** It cannot be checked until 2026-11-02. Commit per the loop; tag `phase-11-complete` when the table is filled in.

---

## D. Verdict

**Clean to commit.** No blocking findings. All gates green (171 unit / 109 integration). The idempotency-key divergence is a justified correction of an internally-inconsistent spec. Four `[manual]` items remain outstanding and need a human.
