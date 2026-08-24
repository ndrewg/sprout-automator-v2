# Phase 13 — Holiday detection, layered

**Goal:** stop clocking people in on holidays. The current check is wired correctly and filters on the wrong thing, and behind that sits a data problem no bundled library can solve.

**Attach for this session:** `03-CONVENTIONS-AND-GUARDRAILS.md`, `02-DECISIONS-AND-ARCHITECTURE.md` (§ holidays), `phases/phase-7-schedule-pause.md` (the pause window this must not duplicate), `reference/testing-strategy.md`.

> 📡 **Fetch live docs (Context7):** `date-holidays` (the `type` taxonomy and `isHoliday` return shape), `node-cron` for 13C. Do not write these from memory.

---

## The defects, in order of how much they cost

A real scheduled run clocked the operator in on a holiday in August 2026. The wiring is **not** the problem — `services/scheduler.ts:106` calls `isPhilippineHoliday(now)` and returns early. Four things are:

**1. `optional` is not in the skip set.** `lib/ph-holidays.ts:11`:

```ts
const SKIP_TYPES = new Set(["public", "bank"]);
```

`date-holidays` classifies Philippine **special (non-working) days** as `optional`. Verified against the installed version, 2026:

```
2026-02-17 | optional | Chinese New Year
2026-08-21 | optional | Ninoy Aquino Day        <-- next one
2026-11-01 | optional | All Saints' Day
2026-11-02 | optional | All Souls' Day
2026-12-08 | optional | Immaculate Conception
2026-12-24 | optional | Christmas Eve
2026-12-31 | optional | New Year's Eve
```

**Eight days in 2026 are treated as ordinary workdays.** The operator does not work them.

**2. Proclamation days are absent entirely.** The installed dataset returns **31 entries for 2026**. Days declared by presidential proclamation part-way through a year cannot be in a dataset published before them, so the scheduler has no way to know.

**3. Lunar holidays carry a computed date, not the proclaimed one.** The library gives Eid al-Fitr 2026 as `2026-03-20`, typed `public` — so it *looks* handled. But the Philippines proclaims Eid after the moon sighting, routinely a day either side of the astronomical date. When they disagree you get **both** failures at once: a skip on a working day, and a clock-in on the actual holiday. **No bundled dataset can ever be correct here**; this is the case that requires an authoritative source.

**4. Two pieces of dead scaffolding.** `isYearCovered()` (`ph-holidays.ts:54`) returns `true` unconditionally and is called by nothing — a staleness guard hardcoded to "fine". `EXTRAS` (`ph-holidays.ts:6`) is the override hook, commented out, and changing it requires an image rebuild.

## The principle every gate below follows

**Clocking in on a day you did not work is a false payroll record. Failing to clock in is a button press plus an alert you already receive.** The costs are not symmetric, so:

- **Fail safe means skip.**
- **Any automated source may only *add* a skip, never cancel one.**
- **A skip whose basis is anything less than certain must notify**, so a wrong skip costs one click the same morning rather than surfacing at payroll.

---

## 13A — Fix the type filter (urgent: ships before 2026-08-21)

**Contract:**
- Add `optional` to `SKIP_TYPES`.
- **`isPhilippineHoliday` returns the type, not just the name.** It is currently `string | null` (`ph-holidays.ts:17`); widen it to `{ name: string; type: string; source: "library" | "override" } | null` so callers can tell a regular holiday from a special non-working day. Update all three callers: `services/scheduler.ts:106`, `routes/schedule.ts:37`, `services/notifications.ts:280`.
- **Notify on an `optional` skip.** Name the holiday, say it is a special non-working day, and say that "Clock in now" is there if they are working. **A `public` skip stays silent** — nobody needs a Christmas Day message, and a channel that fires on every predictable holiday is a channel people mute.
- **⚠️ There is no run row to hang the notification on.** `fireCron` returns at `scheduler.ts:112` *before* anything is inserted, so this cannot reuse the run-finished path in `services/notifications.ts`. It needs its own dispatch, and it needs **idempotency**: a container restart, or two cron fires in one day (in and out), must not produce duplicate messages. Use the same "let the database decide" pattern as the missed-run notices (D17) — insert a row keyed on `(user_id, manila_date, action)` and send only if the insert won. Do **not** hold state in memory.
- Delete `isYearCovered()`, or give it a real implementation. Do not leave a guard that cannot fail.
- Keep the existing `EXTRAS` short-circuit working until 13B replaces it.

**Tests (unit, injected clock — no exceptions):**
- `2026-08-21` (optional) skips. `2026-12-25` (public) skips. `2026-06-19` (observance) does **not** skip. An ordinary Tuesday does not skip.
- The returned `type` is correct for each, so a caller can branch on it.
- The notification fires for `optional` and **not** for `public`.
- Second dispatch for the same user, date and action is suppressed.
- **Every fixture passes its own `now`.** A test that reads the wall clock is the next date time-bomb — `missed-run-sweep` did exactly this on 2026-08-11 (`BACKLOG.md` § 11).

**Gate 13A:** `cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration`

**This gate stands alone. Ship it before 21 August even if the rest of the phase is unfinished.**

---

## 13B — Overrides that do not need a rebuild

**The defect.** `EXTRAS` is compiled in, so adding a proclamation day means editing TypeScript and rebuilding the image — on a Windows workstation, at whatever hour the proclamation lands.

**Contract:**
- New config key **`EXTRA_HOLIDAYS`** — comma-separated `YYYY-MM-DD=Name` entries.
- Parse and validate with the shape already established by `lib/signup-allowlist.ts` and `lib/trusted-peers.ts`: trim entries, drop empties, and **refuse to boot on a malformed one**, naming the position and the fix. A silently-dropped entry is a holiday that does not skip, which is the whole bug this phase exists to fix.
- Validate the date is a real calendar date, not merely `\d{4}-\d{2}-\d{2}` — `2026-02-31` must be rejected.
- Add to `config.ts`, `.env.example` **and both compose files** in this gate. Phase 8 § 8A exists because that step was skipped once.
- An override is reported with `source: "override"` and always notifies, since a human typed it and a typo should be visible.
- **Leave the per-user pause window alone.** That is the self-service path for one person's leave (phase 7); this key is the operator's, for days that affect everyone. They must not be merged.

**Tests:** a valid entry skips; a malformed date refuses boot; an empty or unset key is fine; an override wins over the library for the same date.

**Gate 13B:** `cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration` · `docker compose config 2>&1 | grep -c "is not set"` must stay `0`

---

## 13C — The Official Gazette as an advisory layer

**Why the Gazette and not news.** `officialgazette.gov.ph` publishes the proclamations themselves. A hit there is the legal instrument, not a journalist's summary of one — and it is the only source that can settle a lunar-holiday date. News may be added later as a *secondary* signal; it must never be the deciding one.

**Contract:**
- A **nightly** `node-cron` job fetches and caches proclamation holidays into a new table. New migration; **never edit a committed migration.**
- **Cache-first at decision time. The scheduler must not make a network call on the critical path.** A cold or stale cache degrades to the library — it must never delay or block a 05:30 run.
- **Additive only.** A fetched day may *add* a skip. It may **never** cancel one the library or an override found. A source able to switch skipping *off* is a source able to cause a false payroll record.
- **Skip-and-notify, always.** Every skip attributed to this layer names the proclamation in the message, so a wrong read is visible that morning.
- **⚠️ Locality is the trap, and it is the most likely way this feature does harm.** Proclamations are frequently city- or province-scoped, and "classes suspended in NCR" is a suspension for schools in one region, not a national holiday. **If national scope cannot be established confidently, do not skip** — record the candidate and notify it as a *possible* holiday so the human decides. Never infer national scope from the absence of a qualifier.
- **Lunar holidays are the payoff.** When the Gazette's Eid date disagrees with the library's computed date, the Gazette adds its date, and the notification says the library's date looks wrong. Do not silently rewrite the library's answer.
- Fetch failures are **non-fatal**: log once, keep the previous cache, never affect a run. Same contract as notifications (AGENTS.md rule 11), and it must be asserted by a test, not intended.
- **No new dependency** for HTML parsing unless unavoidable. If one is needed, name it and justify it in the report — each is supply-chain surface (rule 1).
- Nothing user-identifying goes out with the request.

**Tests:**
- A cached national proclamation adds a skip; a cached city-scoped one does **not**.
- An ambiguous-scope entry produces a notification but no skip.
- A fetch that throws or hangs leaves the previous cache intact and **does not affect a scheduled run** — model this on `notification-isolation.test.ts`, which asserts the same property for Telegram.
- The fetched layer cannot cancel a library or override skip, asserted directly.

**Gate 13C:** `cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration`

---

## Verification Gate (the whole phase)

```
cd app/backend  && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration
cd app/frontend && pnpm lint && pnpm test && pnpm build
docker compose config 2>&1 | grep -c "is not set"
```

Baselines: **161 backend unit / 106 backend integration / 5 frontend unit / 16 e2e.** Higher is expected; lower is a finding.

**`[manual]` — must not be claimed as passed:**

| # | Check | Pass looks like |
|---|---|---|
| 1 | **21 Aug 2026 (Ninoy Aquino Day), real scheduled run** | No clock-in. A Telegram naming it as a special non-working day and mentioning "Clock in now" |
| 2 | Set `EXTRA_HOLIDAYS` to tomorrow, wait for the fire | Skipped, notification names the override |
| 3 | Set `EXTRA_HOLIDAYS` to `2026-02-31=Nope`, restart | **Refuses to boot**, naming the entry and the fix |
| 4 | A real proclamation day after 13C ships | Skipped, notification names the proclamation |
| 5 | Block outbound access to the Gazette, then let a run fire | Run completes normally and on time; one log line about the failed fetch |
| 6 | A `public` holiday (e.g. 30 Nov) | Skipped **silently** — no Telegram |

Row 1 is the one that matters, and it can only be checked on the day. Commit per the loop in `AGENTS.md`; tag `phase-13-complete` when the table is filled in.
