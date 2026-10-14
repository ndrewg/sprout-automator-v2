# Phase 16 addendum — tester's report (Workday gate and the day calendar)

**Tester round:** 2026-10-14, on the work PC (`DESKTOP-3SV8V8A`). No earlier round exists; this file is round 1.
**I fixed nothing.** Every source edit I made was a temporary probe, restored byte-exact and re-verified (see § A.11 and the closing note).

---

## A — what I verified structurally (so the reviewer confirms rather than repeats)

### A.1 Gates re-run from scratch (not trusting the report's paste)

```
$ cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration
$ oxlint
$ tsc --noEmit
 Test Files  25 passed (25)
      Tests  271 passed (271)          # unit
 Test Files  31 passed (31)
      Tests  182 passed (182)          # integration
BACKEND GATES ALL GREEN

$ cd app/frontend && pnpm lint && pnpm build && pnpm test && pnpm test:e2e
 Test Files  1 passed (1)
      Tests  5 passed (5)              # frontend unit
  22 passed (13.0s)                    # e2e, desktop + mobile projects
FRONTEND GATES ALL GREEN
```

Counts match the report and sit **above** the phase-15 baseline (262 / 174 / 5 / 16): **271 unit / 182 integration / 5 frontend / 22 e2e**. No count went down. `docker compose config 2>&1 | grep -c "is not set"` = **0** for the base file and **0** for `docker-compose.yml + docker-compose.prod.yml`. `git grep -n "gazette" -- app/backend/src` is **empty** (also empty across `app/backend/test` and `app/frontend/src`).

### A.2 Database, checked directly in `sprout_test` (psql)

- `day_overrides`: exists; `manila_date` type `date`, `kind` text, `note` text nullable; **unique `day_overrides_user_date` on (user_id, manila_date)**; FK → `users(id)` ON DELETE CASCADE. Matches migration `0009_day_overrides.sql` and `schema.ts:250-277`.
- `heads_up_notices`: exists; **unique `heads_up_notice_once` on (user_id, manila_date)**; FK cascade. Matches `0011_heads_up.sql`.
- `notification_settings.notify_heads_up`: exists, `column_default = true`, NOT NULL. Matches `0011`.
- `gazette_holidays`: `to_regclass` → NULL (dropped). `0010_drop_gazette_holidays.sql` is the only change in it.
- Drizzle journal carries exactly idx 9/10/11 for 0009/0010/0011 (`drizzle/meta/_journal.json`). No other migration was generated.

### A.3 The gate and its callers (file:line)

- Precedence ladder lives in ONE place: `app/backend/src/services/workday.ts:200-274` (`decideFromLoaded`: override → pause → weekend → company/library holiday), pure and injectable. `decideDay` (`:437-473`) and `decideRange` (`:480-532`) both route every read through `safeRead` (`:410-422`) — never throws; degrade logs **only `errName`** (`:319-332`), so no error text (and therefore no secret) can reach the log. Once-per-hour cooldown with an exported test reset (`:334-337`).
- The module owns every Manila helper (`manilaDateString`, `manilaHhmm`, `manilaNoon`, `addManilaDays`, `formatManilaDay`, `isWeekend`, `expectedFireTime`, `isPausedOn/isPausedOnDay` — `workday.ts:39-136`). The old copies are gone from `ph-holidays.ts`, `wall-clock-tick.ts`, `notifications.ts`, `retry.ts`; `git grep` shows single definitions. `automation/clock.ts` changed **one line** — its `manilaDateString` import (`clock.ts:5`) — satisfying the rule-10 "do not tidy clock.ts" constraint.
- `fireCron` asks the gate once and acts on the answer (`scheduler.ts:356-401`); no holiday/pause logic remains in the scheduler. `fireClaimedRetry` uses the gate (`run-lifecycle.ts:430-447`) and the separate pause probe is gone. The sweep's `isWorkday` is now `(userId, manilaDate) => decideDay(...).work` (`notifications.ts:501-503`) with **no process-wide weekend/holiday early-return** (`sweepMissedRuns:579-630`) — see B1 for a consequence.
- Gazette deletion is complete: `lib/gazette.ts`, `services/gazette.ts`, `parseProclamations` + tests, the 03:00 tick and the boot refresh are all gone; no dangling import anywhere (`git grep gazette` empty in src/test/frontend); the sweep harness truncate list was updated (`test/integration/harness.ts:55-58`).

### A.4 The day-override API (`routes/schedule.ts`)

- All three routes sit behind `requireAuth` (`schedule.ts:20`) and every query is scoped to `req.user!.id` (`:359-363`, `:396-402`, `:437-445`). **No user id is ever taken from the request**: live probes with `?userId=<uuid>` on GET and `userId` in the PUT body were rejected 400 by the `.strict()` schemas.
- Range cap: `MAX_RANGE_DAYS = 92` (`:247`), enforced (`:351-357`); `isRealDate` rejects `2026-02-31` by noon-round-trip (`:250-259`). Past dates → 400 on PUT and DELETE (`:379-384`, `:430-435`); today allowed. Note ≤ 100 chars, `.strict()` body (`:277-286`).
- Audit: `day_override_set` records `{ date, kind }` **only** (`:406-411`); `day_override_cleared` only when a row was removed (`:447-454`). Verified in psql after a live set with a secret note: `SELECT count(*) FROM audit_log WHERE metadata::text ILIKE '%SECRET-NOTE-7f3a%'` → **0**.
- Setting today to a skip cancels today's pending retries through the lifecycle (`:318-327`, `:413`); clearing does the reverse-safe thing (only cancels if the new decision is skip).

### A.5 Live two-account attack (real server on :4310, real cookies, `curl --noproxy '*'`)

| Probe | Result |
|---|---|
| A sets skip + secret note on 2026-11-05 | 200, note returned to A (owner's own data) |
| B GETs that day | 200, `override: null` — A's row invisible |
| B PUTs `work` on the same day, then DELETEs | 200/200 — A's row **untouched** |
| A re-reads | still `skip` + note — survived B's write+delete |
| Past date PUT / DELETE | 400 / 400 |
| 101-char note; unknown body field; unknown query key | 400 / 400 / 400 |
| Unreal date 2026-02-31 | 400 |
| Reversed range; 181-day range; exact 92-day range | 400 / 400 / 200 |
| Unauthenticated GET | 401 |

### A.6 Notifications policy

- `TOGGLE_FOR_KIND` (`notifications.ts:66-90`): `skip → notifyOnSkipped` (phase-16 contract, supersedes phase-11's `notifyOnMissed` mapping), `heads_up → notifyHeadsUp` (new toggle, default true). `notifySkip` refuses weekends and work-decisions (`:353-360`), dedupes via `holiday_skip_notices` insert-with-`onConflictDoNothing` (database decides), and renders **only `reason.label`** — the user's `note` text never reaches Telegram or the logs (`renderSkipMessage`, `:180-193`). Same for the heads-up (`renderHeadsUpMessage`).
- Heads-up: fires from `finishRun` **only for `action === "out"`**, any terminal status, fire-and-forget with the sanctioned `.catch(() => {})` (`run-lifecycle.ts:233-244`); once/user/Manila-day via `heads_up_notices` (`notifications.ts:455-467`); names the next workday via the gate's `nextWorkday` (14-day search) and carries an `APP_URL` link. A clock-out that never ran sends nothing (no run row → no `finishRun`) — matches the contract.

### A.7 Frontend

- `ScheduleCalendar.tsx` renders **entirely** from `useScheduleDays` (`ScheduleCalendar.tsx:100-107`); no gate logic in the browser — the only date maths are local calendar-month boundaries for the query range, never a work/skip decision. Mutations go through `mutateAsync` in an async handler with try/catch (`:168-179`, rule 12) and invalidate `["schedule-days"]` + `["schedule"]` (`useSchedule.ts`).
- Non-colour signals: per-kind cell classes + legend + `aria-label` on every day button (`:111-143`, `:196-209`, `:213-254`). The two contrast defects the report claims axe found are visibly fixed in the code comments (`:133-137`).
- e2e `calendar.spec.ts` (3 tests × 2 projects): holiday→work survives reload, workday→skip + Escape-focus-return + clear, and an axe check including the portaled popover. `runs-history.spec.ts` correctly rescoped to `[data-testid="runs-panel"]` (the calendar's react-day-picker `<table>` would otherwise be counted).
- Playwright `mobile` project is a **375×812 viewport** (`playwright.config.ts:25`) — the calendar e2e runs there too.

### A.8 Dependency currency (the LATEST-TECH rule)

Checked against the npm registry today (2026-10-14):

| Package | Installed | npm latest | Verdict |
|---|---|---|---|
| `@axe-core/playwright` (devDep) | ^4.13.0 | **4.13.0** | latest stable ✅ |
| `react-day-picker` | ^10.0.2 | **10.0.2** | latest stable ✅ |
| `date-fns` | ^4.4.0 | v4.x (rdp needs ^4.1.0) | fine ✅ |
| `cn` | ^0.4.0 | 0.4.0 | latest, but **unused — see B2** |

react-day-picker v10 API usage was checked against **current** Context7 docs for v10.0.2: `components.DayButton`, `modifiers`, `modifiersClassNames`, controlled `month`/`onMonthChange` are all the current recommended APIs. No deprecated API found in this phase's frontend code.

### A.9 Probes — every headline test proven able to FAIL (break → red → restore → green)

| # | Claim under test | Break injected | Result |
|---|---|---|---|
| 1 | override beats pause | pause checked before override in `decideFromLoaded` | `1c. a user override BEATS a pause` **failed** ✅ |
| 2 | degrade on read error | `safeRead` returned `await read()` with no try/catch | 3 degrade tests **failed** ✅ |
| 3 | day-overrides tenant isolation | user filter dropped from `loadOverridesInRange` | `another user cannot see or disturb` **failed** ✅ |
| 4 | past-date 400 | past-date guard emptied in PUT | `rejects a past date` **failed** ✅ |
| 5 | skip-today cancels retry | `if (!decision.work)` inverted | both retry tests **failed** ✅ |
| 6 | heads-up once/day | `onConflictDoNothing` → `onConflictDoUpdate`, guard removed | `sends once per user per day` **failed** ✅ |
| 7 | heads-up mute | `TOGGLE_FOR_KIND.heads_up` → `notifyOnSuccess` | `is muted by the notify_heads_up toggle` **failed** ✅ |
| 8 | heads-up fires on clock-out only | `finishRun` condition `"out"` → `"in"` | both trigger tests **failed** ✅ |
| 9 | public holiday no longer silent | phase-11 silence guard re-added in `notifySkip` | `public library holiday now NOTIFIES` **failed** ✅ |
| 10 | set/replace/clear round-trip | upsert → plain insert (unique violation on replace) | `sets, replaces and clears` **failed** ✅ |
| 11 | calendar a11y (axe) | `weekendMod` reverted to `text-muted-foreground/60` | axe e2e **failed on desktop + mobile** ✅; restore → 6/6 green ✅ |

After all probes: `git grep -n "PROBE" -- app/backend/src` empty; the three touched integration files re-run green (24/24); the calendar spec re-run green (6/6); the **full backend suite re-run from cold after restoration** (see A.1). `git status` at the end shows only the phase's own files plus the two stray artifacts noted in B7 — **my probes left no trace**.

### A.10 Report-vs-reality diff

Every file in the working tree is either named in the Handoff report, a generated migration/snapshot, or one of the three doc pre-edits the report claims (STATE.md, BACKLOG.md, phase-16 file) — plus the reference-doc updates (`api-contract.md`, `database-schema.md`) which the phase file itself required in 16B. **Nothing changed but unreported**, except the pre-existing `.opencode/agent/orchestrator.md` + `opencode.json` (disclosed by the report as "not mine" — see B8) and the two stray root artifacts (B7). The doc pre-edits are accurate and appropriately scoped **except** the one over-claim in B3.

---

## B — defects found

### B1 — **BLOCKING** — a weekend "work anyway" override promises a clock-in the scheduler will never make, and raises a false missed-run alert

**Concrete failure scenario.** On Friday evening the user opens the calendar and marks **Saturday 2026-11-07** "Work this day" (the button IS offered: `ScheduleCalendar.tsx:353-367` shows it for any non-work day with no override, weekends included). Then:

1. `PUT /schedule/days/2026-11-07 {kind:"work"}` → 200; the gate returns `work: true, reason: work_override` (precedence 1 beats weekend at `workday.ts:237`). The calendar now renders the Saturday as **"Work day — clocking in and out"**.
2. Friday's 16:15 clock-out triggers the heads-up. `nextWorkday` scans from Saturday; the marked Saturday is the first `work: true` day, so `renderHeadsUpMessage` takes the `work_override` branch (`notifications.ts:227-235`) and sends: *"Sat 7 Nov is a holiday you marked as a workday, so clocking in at 05:30."* — a promise (and a wrong label: it is a weekend, not a holiday).
3. Saturday 05:30 comes: **`dueSlots` returns `[]` for any weekend before the gate is ever consulted** (`scheduler.ts:110`, `if (isWeekend(manilaDate)) return [];`). No run is created. Nothing happens.
4. Saturday 05:50: the missed-run sweep has **no process-wide weekend filter any more** (removed in this phase — it is now per-user via the gate, `notifications.ts:579-630`). The gate says this user **should** have been clocked (step 1), no run exists, grace has passed → a 🔴 **false "Missed the 05:30 clock-in" alert** is sent, and again effectively once per action for the day.

Three surfaces of the same system — calendar, heads-up, sweep — now say "you will be / should have been clocked" while the scheduler structurally cannot fire. The phase exists to make exactly this class of disagreement impossible, and 16A's own contract says *"dueSlots … Each one asks the gate and keeps no gate logic of its own"* — the kept weekend check violates that sentence.

**Not covered by any test**: no test marks a weekend as `work` (the e2e "skip" test picks a *workday* via the API on purpose; the gate unit tests never combine a weekend with a `work` override and then a scheduler call).

**Fix directions (coder's/reviewer's call, I did not implement any):** either (a) route `dueSlots`' weekend test through the gate per-user (the phase file's own wording), or (b) refuse/ignore `kind: "work"` overrides that fall on a weekend at the API or gate level, and hide the "Work this day" button on weekend cells. Whichever is chosen, the heads-up text and the sweep must end up agreeing with the scheduler.

### B2 — unused production dependency `cn@0.4.0` (supply-chain surface)

`app/frontend/package.json` gained `"cn": "^0.4.0"` (shadcn's new compiled clsx+tailwind-merge). **Nothing imports it**: every component, including the new `calendar.tsx`/`popover.tsx`, imports `cn` from `@/lib/utils`, which is the old `clsx` + `tailwind-merge` implementation (`src/lib/utils.ts`). The phase file's as-built note 7 says the registry's `import { cn } from "cn"` was *repointed* at `@/lib/utils` — the `pnpm add` that preceded the repoint was never undone. AGENTS.md rule 1: each dependency is supply-chain surface; this one is pure liability. **Remove it from `dependencies`** (it stays in the lockfile only until the next install prunes it). Not blocking behaviour; blocking for commit hygiene.

### B3 — STATE.md pre-edit claims a commit that does not exist

`rebuild/STATE.md` queue row now reads `~~16~~ … ✅ **code committed 2026-10-14**` — but `git log` head is still `ec82787` (phase 15); nothing phase-16 is committed. The implementer was explicit that the doc edits "belong to the reviewer's commit step", so this line pre-empts it and, if the review sends a fix round, leaves the ledger false in between. Everything else in the pre-edits (the deploy note for 0009/0010/0011, the "Known gaps" phase-16 notes, BACKLOG § 18 closure, the phase-file as-built notes 1–11, both reference docs) is accurate and appropriately scoped. **Reviewer: either revert the "committed" claim until the commit lands, or treat this row as part of the commit it describes.**

### B4 — CI's blocking audit gate will fail on the next push (drift, not phase 16)

`.github/workflows/ci.yml` blocks on `pnpm audit --audit-level=high --prod`. Measured today:

- **backend**: 16 prod findings — **CRITICAL `proxy-addr` (IP spoofing via IPv4-mapped IPv6 trust subnet, via `express>proxy-addr`)** + 2 high `nodemailer` (via `mailparser`). The proxy-addr one directly concerns this app's trust-proxy/rate-limit keying posture.
- **frontend**: 60 prod findings — 1 critical + 25 high, **all routed through the pre-existing `shadcn` and `@tailwindcss/vite` trees** (a scaffolding CLI sitting in `dependencies`).

I verified **none** of the findings route through phase 16's additions (`cn`, `date-fns`, `react-day-picker`, `@axe-core/playwright` — zero advisories). This is accumulated drift since phase 10's clean audit of 2026-08-24. Per the LATEST-TECH rule I report rather than bump mid-phase; **the reviewer must decide** (a dependency-hygiene follow-up, or accepting a red CI until then). Note `shadcn` being a *production* dependency at all is worth revisiting — it ships a CLI and its whole tree into the prod image.

### B5 — heads-up ledger row is consumed before the mute check and before the send (low)

`notifyHeadsUp` inserts into `heads_up_notices` (`notifications.ts:455-467`) **before** `dispatch` applies the `notify_heads_up` toggle or attempts the Telegram send. Consequences: (a) a user who mutes the toggle and unmutes it the *same* evening gets no heads-up until the next day; (b) a Telegram outage at 16:15 loses that evening's message permanently (no retry — unlike `missed_run_notices`, which carries `notified_at` for exactly this). The once-per-day tests pass either way, and the insert-then-send pattern matches the phase-11 skip notices, so this is consistent precedent rather than a regression — recorded so the reviewer can accept it explicitly. (My probe #6/#7 confirmed the tests cannot distinguish these cases.)

### B6 — heads-up mislabels a weekend next-day as a holiday in the `work_override` branch (cosmetic, folds into B1)

`renderHeadsUpMessage`'s work-override branch hardcodes *"is a holiday you marked as a workday"* (`notifications.ts:227-235`). For a weekend override (B1's scenario) the day is not a holiday. If B1 is fixed by rejecting weekend overrides, this dies with it; otherwise the wording should key off `reason.code` vs. the day's actual kind.

### B7 — two untracked artifacts appeared in the repo root mid-session (not the coder's, not mine)

`screencapture-kmcsolutions-hrhub-ph-EmployeeDashboard-aspx-2026-10-14-12_35_34.png` and `view-source_https___kmcsolutions.hrhub.ph_EmployeeDashboard.aspx.html` were **not** present at the start of my round (12:29) and appeared by 12:55 — real HRHub dashboard content, presumably captured by the operator (phase 17 material?). I did not create, read in depth, or delete them. **Reviewer: do not commit them** (AGENTS.md: never commit `data/`-class artifacts; they may contain real employee data), and the human should move them out of the repo root.

### B8 — `.opencode/agent/orchestrator.md` flips the orchestrator's bash `"*": deny` → `"*": allow`; `opencode.json` permission-schema change

Disclosed by the report as pre-existing/not-mine; I could not verify provenance (section C). Reviewer: decide deliberately whether these belong in the phase-16 commit (I suggest **not** — a separate operator commit, or revert). The bash-deny flip materially widens what the orchestrator agent may run.

### B9 — doc nit: `api-contract.md` says `/schedule/days` is "rate-limited 120/min" (low)

True only at the default; the budget is now the `API_RATE_LIMIT` dial. Suggest "(default 120/min, `API_RATE_LIMIT`)" so the reference stays honest — the same doc section is otherwise accurate and I matched it line-by-line against the implementation.

---

## C — what I could not verify, and why (read this hardest)

1. **A real Telegram message** for a skip or a heads-up. No live bot token is available from here; every verification used an injected `SendFn` or the dead-port transport. Message *text* is unit-verified; *delivery*, HTML rendering in a real client, and the `APP_URL` link target are not. (Manual rows 2–5 of the phase file still stand.)
2. **The real 2026-11-02 All Souls' Day** end-to-end (Friday heads-up names it, Monday sends the skip, no clock-in). The library data was exercised in tests (`2026-11-02` appears in the heads-up test), but the calendar-date reality — that `date-holidays` still labels it on that exact date in the shipped version — is a `[manual]`.
3. **Applying migrations 0009/0010/0011 to the live `sprout` databases** (work-PC dev DB and the laptop). Out of bounds here (production guard; I only touched `sprout_test`, which the integration suite migrates itself). The phase-10 from-empty schema diff is still unrun, so 0009–0011 sit on the same unverified base — the deploy note in STATE.md correctly says migrate before boot.
4. **A real phone at 375 px.** The Playwright `mobile` project is a 375×812 *Desktop Chrome* viewport — no touch events, no device pixel ratio, no real browser chrome. The calendar e2e (including axe) runs there and passed, but a human holding a phone is still the only true check for the popover fit and tap targets. Likewise a wide desktop eyeball for the legend.
5. **The B1 weekend defect "live".** I proved it by code-reading (`scheduler.ts:110` + the per-user sweep + the heads-up branch) — all three legs are unambiguous in the source — but I could not wait for a real Saturday 05:30 to watch the false missed-run alert fire. Whoever fixes it should add the missing test rather than trust this prose.
6. **GitHub Actions itself.** The CI audit failure (B4) is predicted from a local `pnpm audit`, not from a real workflow run. Same for the rest of CI on this diff.
7. **Provenance of the B7/B8 stray files** — I can only say what `git status` showed and when.
8. **Sustained load of the gate's extra DB reads.** `fireCron`, the sweep (per user, every 5 min), and `nextWorkday` (14 `decideFromLoaded` iterations with a `date-holidays` lookup each) all added queries/CPU to the tick. With one user this is noise; I did not measure a multi-user tick.

---

## D — `[manual]` checks (only a human can do these; results column deliberately empty)

Carried forward: the phase file's five rows (1–5 below) plus the phase-15 deploy row, then new rows for this round.

| # | Check | Exact steps | Pass looks like | Results |
|---|---|---|---|---|
| 1 | Calendar at 375 px and on desktop | Open `http://localhost:3000` on a phone (or devtools 375×812) and on a desktop → Schedule panel → scroll to Calendar; tap a day; open a weekend day, a holiday and a paused day | Legend readable; holidays/weekends/pause visible with their non-colour signals; popover fits; no sideways page scroll; Close returns focus to the day | |
| 2 | Mark tomorrow "skip" in the evening | In the calendar, select tomorrow → "Skip this day". Wait for the next morning's 05:30 slot | No clock-in run appears; one Telegram "Skipping today: your skip day" (suppressed if `notify_on_skipped` is off) | |
| 3 | Mark an upcoming holiday "work anyway" | Select a real upcoming PH holiday → "Work this day". Wait for its 05:30 | The run fires and clocks in; the calendar shows "Work day" | |
| 4 | Heads-up after a real 16:15 clock-out | Let a real clock-out run finish in the evening | One "🌙 Heads-up" naming the correct next workday and clock-in time; the dashboard link opens the app | |
| 5 | The next real library holiday — 2026-11-02 (Mon, All Souls' Day) | On Fri 2026-10-30's heads-up, read the message; on Monday 11-02 wait for 05:30 | Friday's heads-up says Monday is skipped and names Tuesday; Monday sends one skip message; no clock-in on Monday | |
| 6 | Migrations on the dev DB, then boot | `cd app/backend && pnpm exec tsx --env-file=../../.env src/db/migrate.ts`, then `pnpm dev` → `GET /health` | Migrations 0008–0011 apply cleanly; `/health` `db: ok`; `/schedule` shows the calendar | |
| 7 | **Laptop deploy (the scheduled host)** — `SCHEDULER_ENABLED=true` **and** 0008–0011 | On the laptop: set `SCHEDULER_ENABLED=true` in `.env`; `pnpm db:migrate`; `docker compose up -d --build backend` **outside 05:15–05:45 / 16:00–16:30 Manila**; then `docker compose logs backend \| grep -E "scheduler enabled|loaded schedules"` and `GET /health` | `scheduler.enabled: true`, `registeredMatchesEnabled: true`, `drizzle.__drizzle_migrations` ≥ 12, `gazette_holidays` gone, next scheduled slot fires | |
| 8 | **New — weekend "work" override (B1)** | After the fix: mark a Saturday "Work this day" in the calendar, then the next Saturday morning | Calendar, heads-up and scheduler all agree — either the button is refused/hidden and no false promise is sent, OR the clock-in actually fires. **Under the current code the pass condition is "refused"; if it is "fires", `dueSlots` must have been changed** | |
| 9 | Tag | After rows 1–8 pass | `git tag phase-16-complete` exists | |

---

## Closing note — working-tree cleanliness

I made eleven temporary source edits (probes 1–11, § A.9) plus one frontend contrast revert. All were restored: `git grep -n "PROBE"` over `app/backend/src` and `app/frontend/src` is empty, the full backend suite was re-run green **after** restoration (271 / 182), the calendar e2e re-run green (6/6), and `git status` shows exactly the phase's files + the doc pre-edits + the three items I flag (B7's two stray artifacts, B8's two opencode files). **The only file I leave changed is this addendum.** I ran no mutating git commands.

---
---

# Fix round — tester's addendum (2026-10-14, afternoon; B1, B2, B6)

**Round 2**, same work PC (`DESKTOP-3SV8V8A`). Scope: the fix-round Handoff report claiming **B1** (weekend `dueSlots` filter), **B2** (unused `cn` dependency) and **B6** ("holiday" mislabel) are fixed. **I fixed nothing.** Two temporary probes were made; both restored (one hash-verified byte-exact — see § B.1).

## A — what I verified structurally (fix round)

### A.1 Gates re-run from scratch

```
$ cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration
$ oxlint / tsc --noEmit
 Test Files  25 passed (25)   Tests  271 passed (271)   # unit
 Test Files  32 passed (32)   Tests  184 passed (184)   # integration
$ cd app/frontend && pnpm lint && pnpm test && pnpm build && pnpm test:e2e
 Tests  5 passed (5)          # frontend unit
 22 passed (12.5s)            # e2e, desktop + mobile
$ pnpm install --frozen-lockfile  →  "Already up to date" ✅
$ git grep -n "gazette" -- app/backend/src          # EMPTY
$ git grep -n "gazette" -- app/backend/test app/frontend/src app/frontend/e2e  # EMPTY
$ docker compose config … | grep -c "is not set"  =  0 (base) and 0 (prod overlay)
```

Counts **271 unit / 184 integration / 5 frontend / 22 e2e** — integration is **+2 over round 1's 182**, exactly the two new `weekend-gate.test.ts` tests; nothing went down. All four gates re-run **again after the probes were restored** (§ B.1) with identical counts.

### A.2 The B1 change set, file:line

- `scheduler.ts:106-126` — `dueSlots` has **no** `isWeekend` early-return; the `isWeekend` import is gone from `:9`. JSDoc at `:88-105` explains the removal and names defect B1. Timing-only semantics confirmed: weekend slots ARE yielded by wall-clock timing.
- `scheduler.ts:367-401` — `fireCron` asks the gate (`decideDay`, `:377`); non-work → `notifySkip` fire-and-forget (`:396`) + `noteDeliberateSkip` (`:398`) → `skipped` outcome, so the tick marks the slot handled and stays quiet.
- `notifications.ts:349-355` — `notifySkip` keeps the weekend guard (`reason.code === "weekend"` → `"skipped"`, before any DB insert), with the reworded comment naming B1 and explaining that this guard is now what keeps plain weekends quiet.
- `notifications.ts:206-213` — the `work_override` heads-up branch now reads **"…is a day you marked as a workday, so clocking in at HH:MM"** (was "is a holiday you marked as a workday"). Doc example at `:185` updated. `git grep "holiday you marked"` over `app/backend` is **empty**.
- `test/services/scheduler.test.ts` — the old "skips weekends (Mon–Fri only)" assertion is rewritten: a Saturday 05:30 slot now **must** be yielded (`toEqual([{ userId, action: "in", manilaDate: "2026-10-10", slot }])`), with a comment explaining the gate owns the weekend decision.
- `test/integration/weekend-gate.test.ts` (new, 2 tests) — **5a**: Saturday `work` override → `schedulerTick` at a pinned `2026-10-10T05:30:05+08:00` creates exactly one `in` run; then `sweepMissedRuns` at a pinned 06:10 sends **nothing** (no dispatch, no `missed_run_notices` row). **5b**: plain Saturday → no run, no `holiday_skip_notices` row (the guard returns before the insert), no sweep dispatch/notice. Instants pinned, no `Date.now()` in assertions.
- The two wording-updated assertions: `test/services/notifications.test.ts:662-676` and `test/integration/heads-up.test.ts:126-144`, both now expecting "Mon 2 Nov is a day you marked as a workday".

### A.3 The B2/B6 change set

- **`cn` is gone**: `app/frontend/package.json` diff shows only `date-fns`, `react-day-picker` (deps) and `@axe-core/playwright` (devDep) added — no `cn`. `git grep -n 'from "cn"' -- app/frontend/src` **empty** (also empty across all of `app/frontend`). The lockfile has **no standalone `cn` package** (only `shadcn@4.12.0`, the CLI, which round 1 already flagged under B4). `pnpm install --frozen-lockfile` passes — package.json and lockfile agree.
- **B6 wording** landed as in A.2; no other heads-up text changed.
- No new migration: `app/backend/drizzle/` ends at `0011_heads_up.sql` — the fix round generated nothing.

### A.4 Regression tests proven able to FAIL (break → red → restore → green)

| # | Probe | Result |
|---|---|---|
| P1 | Re-added `if (isWeekend(manilaDate)) return [];` to `dueSlots` (+ `isWeekend` import) — i.e. **re-introduced the original B1 bug** | **5a RED**: `AssertionError: expected [] to have a length of 1` at `weekend-gate.test.ts:107` (no run created on the override Saturday). **5b stayed green** — correct: 5b asserts plain-Saturday silence, which is true pre- and post-fix. |
| P2 | Commented out the `notifySkip` weekend guard (`notifications.ts:355`) — i.e. **re-introduced the over-reach half** | **5b RED**: `expected 1 to be +0` at `weekend-gate.test.ts:154` (a `holiday_skip_notices` row written for a plain Saturday). **5a stayed green** — the work-override path never reaches `notifySkip`. |

Restore proof: `scheduler.ts` was restored and its **SHA-256 before probing (`487C4389…AE87`) matches after** — byte-exact. The `notifySkip` guard was restored by exact reverse edit; `git grep -n "PROBE" -- app/backend/src app/backend/test` is **empty**, the guard line is back at `notifications.ts:355`, and the **full backend suite was re-run from cold after restoration: 271 / 184 green**. Both new tests can fail; both halves of the fix are load-bearing.

### A.5 Behavioural walkthroughs (code + tests, no live clock)

- (a) **Override Saturday**: slot yielded (`dueSlots`) → `fireCron` → gate precedence 1 (`workday.ts:204-223`, `work_override`) → `startRun` → run row. Proven by 5a green; proven necessary by P1 red.
- (a') **Plain Saturday**: slot yielded → gate precedence 3 (`workday.ts:237-244`, `weekend`) → `notifySkip` guard refuses before the insert → `noteDeliberateSkip` → handled, silent. Proven by 5b green; proven necessary by P2 red.
- (b) **Sweep on the override Saturday**: gate (per-user, `notifications.ts` sweep `isWorkday` via `decideDay`) says work, `hasRunToday` sees the 05:30 run → no alert. 5a's second half green.
- (c) **Heads-up wording**: Friday 16:15 with a Saturday override → `next.manilaDate === tomorrowDate` + `work_override` branch → "Sat 7 Nov is a day you marked as a workday, so clocking in at 05:30" — a true promise now that the scheduler fires, and no false "holiday" label (B6).

## B — defects and findings (fix round)

### B.1 — **B1 CLOSED.** Proven by P1: re-adding the early-return turns 5a red (`expected [] to have a length of 1`); removing it turns it green. The three surfaces (calendar promise, heads-up, sweep) now agree through the one gate, and 5b proves the fix did not over-reach (P2 red proves 5b bites). The concrete failure scenario from round 1 — Saturday override, no run, false 🔴 missed alert — is exactly what P1 reproduced at the test level.

### B.2 — **B2 CLOSED.** `cn` absent from `app/frontend/package.json`, absent from `pnpm-lock.yaml` as a standalone package, no `from "cn"` import anywhere in `app/frontend`; `--frozen-lockfile` passes. Supply-chain surface removed.

### B.3 — **B6 CLOSED.** The `work_override` heads-up branch (`notifications.ts:210`) says "a day you marked as a workday"; `git grep "holiday you marked"` over `app/backend` is empty; both updated assertions (`notifications.test.ts:676`, `heads-up.test.ts:144`) check the new string.

### B.4 — LOW — a **skip** override on a weekend now sends a "Skipping today" notice (new path opened by the fix; API-only)

**Concrete scenario.** `PUT /schedule/days/2026-10-17 {kind:"skip"}` (a Saturday; the API accepts any future date). Saturday 05:30: the slot is now yielded (the B1 fix), the gate returns `skip_day` (`workday.ts:206-212` — the override beats the weekend), and `notifySkip`'s guard checks `reason.code === "weekend"`, which does **not** match `skip_day` → a "Skipping today: your skip day" Telegram is sent on a Saturday morning. **Pre-fix this could not happen** (no weekend slot → `fireCron` never ran → no notice), so the fix opened the path. Mitigations that already hold: the calendar UI never offers "Skip this day" on a non-work day (`ScheduleCalendar.tsx:338` requires `selectedDay.work`), so only a direct API call reaches it; and 16D's "weekends never notify" arguably covers only *automatic* weekend detection, while an explicit override is user intent. **Reviewer's call** — accept (user asked for it, one message, database-deduped) or extend the guard to skip-override-on-weekend. Not blocking; no test pins either behaviour today.

### B.5 — NOTE (not a defect) — weekends now ping the heartbeat twice per enabled schedule

`fireCron`'s weekend skip path calls `noteDeliberateSkip` → `pingHeartbeat()` (`run-lifecycle.ts:531-534`). Pre-fix, weekends produced no `fireCron` call at all, so Saturday/Sunday were ping-free (Friday 18:05 → Monday 05:30 ≈ a 59 h gap for a dead-man's-switch). Post-fix, an enabled schedule pings ~2×/weekend-day. This is **consistent** with phase 15's contract ("ping on a deliberate skip — holiday, pause, already clocked") and arguably *improves* the dead-man's-switch (smaller max gap; a truly-down host still produces no pings). Recorded so the operator knows weekend pings are expected, not an anomaly.

### B.6 — reaffirmed, NOT fixed (correctly out of this round's scope; reviewer/operator items)

- **B3 (reviewer)** — still false today: the `STATE.md` queue row (`:21`) says "✅ **code committed 2026-10-14**" but `git log` head is still `ec82787` (phase 15); **nothing phase-16 is committed**. Either revert the claim until the commit lands, or treat the row as part of that commit.
- **B3-adjacent, new (reviewer, same commit)** — `STATE.md:145`'s baseline still says "**182** backend integration"; this round measures **184**. The Handoff report discloses leaving the count update to the reviewer; it must land in the same commit or the ledger goes stale again.
- **B4 (reviewer)** — the CI `pnpm audit --audit-level=high --prod` gate will still fail on the next push (16 backend / 60 frontend prod findings, none from phase 16's additions). Decide: dependency-hygiene follow-up or accept red CI. Removing `cn` slightly *reduces* the surface but does not touch the `shadcn`/`proxy-addr` findings.
- **B5 (accepted as-is by the reviewer, no fix)** — the heads-up ledger row is consumed before the mute check and the send; accepted as consistent phase-11 precedent. Recorded here so the closure is explicit.
- **B7 (operator + reviewer)** — the two stray root artifacts (`screencapture-…png`, `view-source_….html`) are **still present and untracked**; `.opencode/agent/orchestrator.md` and `opencode.json` are **still modified**. All four are untouched by the fix round (verified in `git status`). **They must not be staged for the phase-16 commit** — name the phase's files explicitly.
- **B9 (low, reviewer)** — `reference/api-contract.md` still says `/schedule/days` is "rate-limited 120/min" without naming the `API_RATE_LIMIT` dial. Still open.

## C — what I could not verify, and why (fix round)

1. **A real Saturday end-to-end.** 5a/5b prove the scheduler/gate/sweep agreement at pinned instants with an injected tick; I could not watch a real 2026-10-17 05:30 fire on the laptop, deliver a real Telegram, or confirm real HRHub receives the clock-in. `[manual]` row 8 (updated below) is the true check.
2. **The weekend-override heads-up in an integration test.** No test pins "Friday clock-out → heads-up names a Saturday `work_override`". The branch it would take (`notifications.ts:206-213`) is keyed on the override code and is unit-covered for the holiday-override case (`notifications.test.ts:662-676`); the wording no longer depends on the day kind. I verified by code-reading, not by a red/green probe of that specific message.
3. **Mechanically isolating the fix-round delta.** Both rounds sit in one uncommitted working tree (HEAD = phase 15); a commit or stash would be required to diff "round 1 state" vs "round 2 state", and both mutate git. I instead verified each claimed file contains its claimed change (§ A.2/A.3) and that no file exists outside round 1's audited inventory + the fix-round set. If the reviewer wants a strict delta, `git stash` before/after comparison is the tool.
4. **Applying migrations to live `sprout`** (work-PC dev DB and the laptop) — production guard; untouched. `sprout_test` is migrated by the integration suite itself (0009–0011 present, suite green).
5. **GitHub Actions** — the B4 audit prediction is from local `pnpm audit`, not a real workflow run.
6. **Sustained multi-user weekend load** — the gate now runs per weekend slot (2×/user/day of `decideDay` DB reads where pre-fix there were zero). Noise at one user; unmeasured at scale (round 1 C.8 stands).

## D — `[manual]` checks (only a human; results column deliberately empty)

Carried forward from round 1 (rows 1–9), with row 8 updated for the fix's chosen direction ("fires", not "refused"), plus one new row.

| # | Check | Exact steps | Pass looks like | Results |
|---|---|---|---|---|
| 1 | Calendar at 375 px and on desktop | Open `http://localhost:3000` on a phone (or devtools 375×812) and on a desktop → Schedule panel → scroll to Calendar; tap a day; open a weekend day, a holiday and a paused day | Legend readable; holidays/weekends/pause visible with their non-colour signals; popover fits; no sideways page scroll; Close returns focus to the day | |
| 2 | Mark tomorrow "skip" in the evening | In the calendar, select tomorrow → "Skip this day". Wait for the next morning's 05:30 slot | No clock-in run appears; one Telegram "Skipping today: your skip day" (suppressed if `notify_on_skipped` is off) | |
| 3 | Mark an upcoming holiday "work anyway" | Select a real upcoming PH holiday → "Work this day". Wait for its 05:30 | The run fires and clocks in; the calendar shows "Work day" | |
| 4 | Heads-up after a real 16:15 clock-out | Let a real clock-out run finish in the evening | One "🌙 Heads-up" naming the correct next workday and clock-in time; the dashboard link opens the app | |
| 5 | The next real library holiday — 2026-11-02 (Mon, All Souls' Day) | On Fri 2026-10-30's heads-up, read the message; on Monday 11-02 wait for 05:30 | Friday's heads-up says Monday is skipped and names Tuesday; Monday sends one skip message; no clock-in on Monday | |
| 6 | Migrations on the dev DB, then boot | `cd app/backend && pnpm exec tsx --env-file=../../.env src/db/migrate.ts`, then `pnpm dev` → `GET /health` | Migrations 0008–0011 apply cleanly; `/health` `db: ok`; `/schedule` shows the calendar | |
| 7 | **Laptop deploy (the scheduled host)** — `SCHEDULER_ENABLED=true` **and** 0008–0011 | On the laptop: set `SCHEDULER_ENABLED=true` in `.env`; `pnpm db:migrate`; `docker compose up -d --build backend` **outside 05:15–05:45 / 16:00–16:30 Manila**; then `docker compose logs backend \| grep -E "scheduler enabled\|loaded schedules"` and `GET /health` | `scheduler.enabled: true`, `registeredMatchesEnabled: true`, `drizzle.__drizzle_migrations` ≥ 12, next scheduled slot fires | |
| 8 | **Weekend "work" override (B1, FIXED — pass = fires)** | Mark a Saturday "Work this day" in the calendar on a Friday evening; Saturday morning, read Telegram and the Runs panel; also check no 🔴 missed alert appears at ~05:50 | Friday's heads-up names the Saturday as "a day you marked as a workday, so clocking in at 05:30" (no "holiday"); the Saturday 05:30 run fires and clocks in; **no** missed-run alert; a control weekend with no override stays completely silent (no run, no skip message, no alert) | |
| 9 | **New — weekend heartbeat pings (B.5 note)** | With `HEARTBEAT_URL` set to a request-capture endpoint, observe Saturday and Sunday | Two pings per day (one per slot) while the host is up — expected after the B1 fix, not an anomaly | |
| 10 | Tag | After rows 1–9 pass | `git tag phase-16-complete` exists | |

## Closing note — working-tree cleanliness (fix round)

Two temporary edits were made and both restored: `scheduler.ts` **SHA-256 identical before and after** (`487C4389…AE87`), `notifications.ts` restored by exact reverse edit with the guard verified back at line 355. `git grep -n "PROBE"` over `app/backend/src` and `app/backend/test` is empty. The full backend suite was re-run from cold **after restoration**: 271 unit / 184 integration green; frontend untouched by probes (5 unit / 22 e2e green from A.1). `git status` shows the same entries as at the start of my round plus this addendum's update — the stray artifacts (B7) and opencode files (B8) remain untouched and unstaged. **The only file I leave changed is this addendum.** I ran no mutating git commands.
