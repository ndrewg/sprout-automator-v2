# Phase 15 — Post-run remediation

**Goal:** close the gap between "the code landed" and "the evidence it works landed". Phases 10–14 all committed; four things they left behind are stronger than the labels the run report gave them.

**Why this exists.** The orchestrator's final report was honest — its "what I would not trust yet" section surfaced real problems rather than hiding them. Validating that report against the phase specs turned up two outright contradictions of a spec, one under-rated defect, and one report gap. None of it needs reverting. All of it needs closing **before** the domain work, because the deployment that would expose it is the laptop that clocks real people in.

**Attach for this session:** `phases/phase-13-holiday-sourcing.md` (§ 13B — the contract 15A restores), `phases/phase-14-retry.md` (§ 14A/14B — the contract 15C restores), `phases/phase-11-holiday-skip-types.md` (§ 11B — the in-memory rule), `reference/testing-strategy.md`, `03-CONVENTIONS-AND-GUARDRAILS.md`.

**Scope discipline.** This phase adds no user-visible feature. Do not touch the domain/tunnel work (phase 16) or admin (phase 17). Do not "improve" anything phases 10–14 got right — the merge rules in `services/holidays.ts` are correct and well-commented; leave them alone.

---

## 15A — Holiday sourcing must degrade, not throw

**The defect, confirmed in the code.** `services/gazette.ts:62-75`:

```ts
export async function loadGazetteForDate(dateStr: string): Promise<GazetteEntry[]> {
  const rows = await db.select().from(gazetteHolidays)
    .where(eq(gazetteHolidays.manilaDate, dateStr));   // <-- no try/catch
  ...
}
```

`resolveHolidayDecision` awaits it unconditionally (`services/holidays.ts:55`). So on a database where migration `0006_gazette_holidays.sql` has not been applied, Postgres raises `42P01 undefined_table` and it propagates out.

**`phase-13-holiday-sourcing.md` § 13B forbids exactly this, twice:**

> **Cache-first at decision time.** … A cold or stale cache **degrades to the library** rather than blocking.

> Fetch failures are **non-fatal**: log once, keep the previous cache, **never affect a run**.

A missing table is the coldest possible cache. **Throwing is not degrading.**

**And the blast radius is wider than the run report stated.** It said "the app throws on every holiday decision". `resolveHolidayDecision` has four callers:

| Caller | What breaks |
|---|---|
| `services/scheduler.ts` (the cron fire) | **every scheduled clock-in and clock-out** |
| `services/notifications.ts:418` (missed-run sweep) | the alert that would tell you the above broke |
| `services/retry.ts` | phase 14's retry gating |
| `routes/schedule.ts:37` | the dashboard's holiday display |

So an unmigrated database takes out the automation **and** the alarm that watches it. That is the same "the alarm dies with the patient" shape phase 12 was written to eliminate.

**Contract:**
- Wrap the gazette read so **any** failure — missing table, unreadable rows, a connection error — returns **an empty gazette list**, logs **once** (not per call), and lets the decision proceed on library + overrides.
- **Fail safe means the run continues.** The gazette layer is additive-only by design; with no gazette data the correct behaviour is exactly the pre-phase-13 behaviour, which was working.
- Do **not** swallow the error silently and do **not** cache the failure forever — log once per process or with a cooldown, so a genuinely broken table is visible without flooding.
- Leave the merge rules in `resolveHolidayDecision` untouched. Override > library, gazette additive-only, national-only skips — all correct.

**Tests (integration):**
- With the `gazette_holidays` table **dropped**, `resolveHolidayDecision` returns a decision (library + overrides) rather than throwing. **This test must fail against the current code — that is the gate.**
- With the table dropped, a scheduled fire still runs, and a library holiday still skips.
- The "log once" behaviour: repeated calls do not produce one log line each.

**Also in this gate — correct the migration list.** The run report's headline named `0006` and `0007`; `0005_holiday_skip_notices.sql` appears only in a phase-11 bullet. **Three migrations are outstanding: `0005`, `0006`, `0007`.** Record all three in `STATE.md` where an operator will actually look.

**Gate 15A:** `cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration`

---

## 15B — Fix the suite leak, then re-establish the baseline

**The defect.** The reviewer observed **e2e 11/16** and **integration 149/150** on a first run, green only on re-run, and traced it to worker contention plus an in-memory registry leak in `app/backend/test/integration/executor-failure-backstop.test.ts` — it schedules a retry and never tears it down.

The report called this "not a logic regression" and said it makes the count check "slightly less reliable". **That understates it: every green gate in phases 10–14 rests on this suite.** A suite that needs a re-run to pass cannot distinguish "my change is fine" from "my change broke something intermittently" — and phases 10–14 include a nine-minor ORM upgrade.

**The fix is one line, because the function already exists.** `services/retry-registry.ts:105` exports `clearPendingRetries()`.

**Contract:**
- Call `clearPendingRetries()` in that test's `afterEach`. Audit every other integration test that schedules a retry or a timer for the same omission.
- **Then run the whole suite twice from cold** — `docker compose up -d postgres` freshly, both backend projects, both frontend projects — and confirm identical, green results both times.
- **Record the real counts in `rebuild/STATE.md`**, replacing the stale 161 / 106 / 5 / 16 baseline. The run report never stated final backend totals; five phases landed and the one number that would reveal a silently-dropped suite is the one nobody wrote down.
- If flakiness survives the teardown fix, **say so and stop** rather than papering over it with a retry flag. A gate that needs `--retry` is not a gate.

**Gate 15B:** the full suite, twice, from cold, with the counts pasted verbatim in the report.

---

## 15C — Pending retries must survive a restart

**The defect.** Phase 14 keeps pending retries in an in-memory registry (`services/retry-registry.ts`). The run report calls this "documented limitation, not a defect". In isolation that is fair. In this deployment it is not:

- **`phase-11-holiday-skip-types.md` § 11B states the rule outright:** *"Do not hold state in memory — the process restarts."* It was written for notification idempotency; it applies identically here.
- **Phase 12 exists because this host restarts unexpectedly.** A Windows Update reboot with Docker Desktop needing a logged-in session is the largest known risk on it.
- The report concedes the consequence — a dropped retry "can let the missed-run alert re-surface" — and **`phase-14-retry.md` § 14B explicitly requires** *"Suppress the missed-run alert while a retry is pending."* So a documented requirement fails under precisely the condition this host is known for.

Half of retry state is already durable: `runs.attempt` is a column. What is missing is the **schedule**.

**Contract:**
- Persist each pending retry: the run it belongs to, next attempt time, attempts used, and the action.
- **Rebuild the timers at boot from that table**, the way cron schedules are already reloaded at startup (`services/scheduler.ts` loads schedules from the database on boot — mirror that shape rather than inventing a second one).
- On rebuild, **re-apply every existing guard**: the attempt cap, the wall-clock cutoff, the holiday and pause checks. A retry restored after its cutoff must be discarded, not fired. **A restart must never resurrect a retry into a 14:00 clock-in.**
- Cancellation semantics are unchanged and must still hold across a restart: success, a manual run, the next scheduled fire, or the day rolling over all cancel.
- New migration. **Never edit a committed migration.**

**Tests (integration):**
- A pending retry survives a simulated restart (drop and rebuild the registry from the table) and fires at its scheduled time.
- A pending retry whose cutoff has passed is discarded on rebuild, not fired.
- The missed-run alert stays suppressed across the restart.
- A retry cancelled before the restart does not come back.

**Gate 15C:** `cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration`

---

## 15D — The Gazette URL belongs in config

**The defect.** `lib/gazette.ts:33`:

```ts
export const GAZETTE_URL = "https://www.officialgazette.gov.ph/";
```

Not a spec violation — phase 13B allowed a regex over a parsing dependency, and a constant was never forbidden. But it repeats a lesson this project has already learned twice: `EXTRAS` became `EXTRA_HOLIDAYS`, and a code-constant peer set became `TRUSTED_CLOUDFLARE_PEERS`, both because **a value that can change should not need an image rebuild.** A source URL on a government site that reorganises is the same shape.

**Contract:**
- Move it to a config key with the current value as the default, validated at boot (must parse as an `https:` URL) in the manner of `EXTRA_HOLIDAYS`.
- `config.ts`, `.env.example` **and both compose files**, in this gate.
- The extraction regex stays as-is. **Its correctness against the live page is a `[manual]` row, not something this gate can prove** — the run report is right that it is unverified, and making the URL configurable does not change that.

**Gate 15D:** `cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration` · `docker compose config 2>&1 | grep -c "is not set"` must stay `0`

---

## Verification Gate (the whole phase)

```
cd app/backend  && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration
cd app/frontend && pnpm lint && pnpm test && pnpm build && pnpm test:e2e
docker compose config 2>&1 | grep -c "is not set"
```

**Run the backend suite twice from cold** (15B). Report both sets of counts.

**`[manual]` — must not be claimed as passed:**

| # | Check | Pass looks like |
|---|---|---|
| 1 | **Before applying any migration**, restore the latest backup into a scratch DB, run `pnpm db:migrate` **from empty**, and diff tables/indexes/constraints against the live `sprout` DB | Identical — including the `runs_one_active_per_user` partial index. **This is phase 10's unverified row and it comes first**: it is the only check that catches a migration runner silently skipping older migrations after the Drizzle major, and three new migrations now sit on top of that unverified base |
| 2 | Apply `0005`, `0006`, `0007` to the live `sprout` DB | All three applied; app boots; a scheduled fire completes |
| 3 | Point the app at a DB **without** `gazette_holidays` and let a fire happen | The run **completes** on library + overrides, with one log line — not a crash |
| 4 | Restart the container while a retry is pending | The retry still fires at its time, and no duplicate missed-run alert arrives |
| 5 | Read the live Gazette page and compare against what the parser extracts | The regex actually finds the proclamations. Phase 13's rows 3 and 5 remain the real validation |

Row 1 gates rows 2–4. Do not apply a migration to a database holding real encrypted credentials until it passes.

Commit per the loop in `AGENTS.md` — coder reports, tester probes, reviewer commits. Tag `phase-15-complete` when the table is filled in.
