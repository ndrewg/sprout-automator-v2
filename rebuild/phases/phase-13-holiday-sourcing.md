# Phase 13 — Holiday sourcing: overrides and proclamations

**Goal:** know about holidays the bundled dataset cannot know about, without letting an automated source cause a false payroll record.

**Depends on phase 11.** That phase widened `isPhilippineHoliday` to return `{ name, type, source }`; this phase adds two more values of `source`. Do not start with phase 11 unmerged.

**Attach for this session:** `03-CONVENTIONS-AND-GUARDRAILS.md`, `phases/phase-11-holiday-skip-types.md` (the return shape and the fail-safe principle), `phases/phase-7-schedule-pause.md`, `reference/database-schema.md`, `reference/testing-strategy.md`.

> 📡 **Fetch live docs (Context7):** `node-cron` for the nightly job, and whatever HTTP/parsing approach is chosen. Do not write these from memory.

---

## Why a library can never be enough

Phase 11 fixed the filter. Two data problems remain, and neither is fixable by classifying types differently:

**1. Proclamation days are not in the dataset at all.** The installed `date-holidays` returns **31 entries for 2026**. Days declared by presidential proclamation part-way through a year cannot appear in a dataset published before them. The August 2026 run that prompted this work is the evidence.

**2. Lunar holidays carry a computed date, not the proclaimed one.** The library gives Eid al-Fitr 2026 as `2026-03-20`, typed `public` — so it *looks* correct and already skips. But the Philippines proclaims Eid after the moon sighting, routinely a day either side of the astronomical date. **When they disagree you get both failures at once:** a skip on a working day, and a clock-in on the actual holiday. This is the case that requires an authoritative source; no bundled dataset can ever be right about it.

## The rules every gate below obeys

Carried from phase 11, and they are what keep an automated source from doing harm:

- **Additive only.** A new source may *add* a skip. It may **never** cancel one the library or an override already found. A source able to switch skipping *off* is a source able to cause a false payroll record.
- **Never silent.** Every skip attributed to a source beyond the library names that source in the notification, so a wrong read is visible the same morning.
- **Never on the critical path.** The 05:30 decision reads a cache. No network call may delay or block a run.
- **When uncertain, do not skip — notify.** Fail-safe here means "ask the human", because the alternative failure (a missed clock-in on a working day) is the cheap one only when the human finds out.

---

## 13A — Overrides without a rebuild

**The defect.** `EXTRAS` (`lib/ph-holidays.ts:6`) is compiled in, so adding a proclamation day means editing TypeScript and rebuilding the image — on a Windows workstation, at whatever hour the proclamation lands.

**Contract:**
- New config key **`EXTRA_HOLIDAYS`** — comma-separated `YYYY-MM-DD=Name` entries.
- Parse and validate with the shape already established by `lib/signup-allowlist.ts` and `lib/trusted-peers.ts`: trim, drop empties, and **refuse to boot on a malformed entry**, naming the position and the fix. A silently-dropped entry is a holiday that does not skip, which is the exact bug this phase family exists to eliminate.
- **Validate that the date is a real calendar date**, not merely `\d{4}-\d{2}-\d{2}` — `2026-02-31` must refuse.
- Add to `config.ts`, `.env.example` **and both compose files** in this gate. Phase 8 § 8A exists because that step was skipped once.
- An override reports `source: "override"` and **always notifies** — a human typed it, and a typo should be visible the same day.
- Remove the now-dead `EXTRAS` constant once the key works.
- **Leave the per-user pause window alone.** That is one person's leave (phase 7); this key is the operator's, for days affecting everyone. Merging them would make one person's holiday everyone's.

**Tests:** a valid entry skips and notifies; a malformed date refuses boot; an unset or empty key behaves exactly like today; an override wins over the library for the same date.

**Gate 13A:** `cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration` · `docker compose config 2>&1 | grep -c "is not set"` must stay `0`

---

## 13B — The Official Gazette as an advisory layer

**Why the Gazette rather than news.** `officialgazette.gov.ph` publishes the proclamations themselves. A hit there is the legal instrument, not a journalist's summary of one — and it is the only source that can settle a lunar-holiday date. News may be added later as a *secondary* signal; it must never be the deciding one.

**Contract:**
- A **nightly** `node-cron` job fetches proclamation holidays and caches them in a new table. New migration; **never edit a committed migration.**
- **Cache-first at decision time.** The scheduler must not make a network call when deciding whether to run. A cold or stale cache degrades to the library rather than blocking.
- **Additive only**, per the rules above — assert this directly in a test, not by inspection.
- **Skip-and-notify**, naming the proclamation.
- **⚠️ Locality is the trap, and the most likely way this feature does harm.** Proclamations are frequently city- or province-scoped, and "classes suspended in NCR" is a suspension for schools in one region, not a national holiday. **If national scope cannot be established confidently, do not skip** — record the candidate and notify it as a *possible* holiday so the human decides. **Never infer national scope from the absence of a qualifier.**
- **Lunar holidays are the payoff.** When the Gazette's Eid date disagrees with the library's computed one, the Gazette *adds* its date and the notification says the library's date looks wrong. Do not silently rewrite the library's answer — the point is that the human learns the two disagree.
- Fetch failures are **non-fatal**: log once, keep the previous cache, never affect a run. Same contract as notifications (AGENTS.md rule 11), asserted by a test rather than intended.
- **No new dependency** for HTML parsing unless unavoidable. If one is needed, name it and justify it in the report — each is supply-chain surface (rule 1), and phase 10 exists because dependencies drift.
- Nothing user-identifying leaves the process with the request.

**Tests:**
- A cached national proclamation adds a skip; a **city-scoped** one does not.
- An ambiguous-scope entry notifies but does **not** skip.
- The fetched layer **cannot** cancel a library or override skip.
- A fetch that throws or hangs leaves the previous cache intact and **does not affect a scheduled run** — model on `notification-isolation.test.ts`.
- A Gazette Eid date differing from the library's produces a skip on the Gazette date and flags the disagreement.

**Gate 13B:** `cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration`

---

## Verification Gate (the whole phase)

```
cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration
docker compose config 2>&1 | grep -c "is not set"
```

Baselines: **161 backend unit / 106 backend integration** (plus whatever phase 11 added).

**`[manual]` — must not be claimed as passed:**

| # | Check | Pass looks like |
|---|---|---|
| 1 | Set `EXTRA_HOLIDAYS` to tomorrow, wait for the fire | Skipped; notification names the override |
| 2 | Set `EXTRA_HOLIDAYS=2026-02-31=Nope`, restart | **Refuses to boot**, naming the entry and the fix |
| 3 | A real proclamation day, after 13B ships | Skipped; notification names the proclamation |
| 4 | Block outbound access to the Gazette, then let a run fire | Run completes normally and on time; one log line about the failed fetch |
| 5 | Next Eid | The proclaimed date is the one that skips |

Row 5 cannot be scheduled — note it and wait. Commit per the loop in `AGENTS.md`; tag `phase-13-complete` when the table is filled in.
