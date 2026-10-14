# Phase 18 addendum — tester report (§ 18D code+docs round)

**Tester round:** 2026-10-14, on `DESKTOP-3SV8V8A` (the **work PC** — production-guard rules for the laptop did not apply here; tests used `sprout_test` only; nothing under `sprout-backend` was touched; healthchecks.io was never contacted).

**Verdict:** the § 18D change is sound. Gates re-run green (326 unit / 190 integration — above the 322 / 188 floor). No secret leak (proved by live probe and by mutation). 18A/18B/18C were **not** touched. **No BLOCKING defects.** One minor doc defect (B1) and two process cautions for the reviewer (B2, B3).

---

## A — structural verification (reviewer: confirm, don't repeat)

**Gates re-run by the tester (not trusted from the report):**

| Gate | Command | Result |
|---|---|---|
| lint | `cd app/backend && pnpm lint` | exit 0 |
| typecheck | `pnpm typecheck` | exit 0 |
| unit | `pnpm test` | **326/326**, 29 files (STATE.md baseline floor 322 — above) |
| integration | `pnpm test:integration` (Postgres up via `docker compose up -d postgres`) | **190/190**, 33 files (floor 188 — above) |
| compose warnings | `docker compose config` + `-f docker-compose.yml -f docker-compose.prod.yml config` | "is not set" count = **0 / 0** |
| re-run after probes | full lint+typecheck+unit+integration after all mutations restored | green, 326 / 190 again |

**Diff scope — exactly the reported 18D set, verified via `git status --porcelain` / `git diff --stat`:**
`app/backend/src/lib/heartbeat.ts` (+18), `app/backend/src/app.ts` (+12), `app/backend/test/lib/heartbeat.test.ts` (+58), `app/backend/test/integration/health.test.ts` (+35), `RUNNING.md`, `DEPLOY.md` (new § 6.4), `rebuild/02-DECISIONS-AND-ARCHITECTURE.md` (D12), `rebuild/STATE.md` (header, queue row 18, one Built-and-verified row, one Known-gaps entry — all scoped to § 18D), `rebuild/phases/phase-18-host-and-outside-alerting.md` (the as-built note, 2 lines).
**Confirmed absent from the diff:** no `docker-compose*.yml`, no `.env`/`.env.example`, no `scripts/*.ps1`, no `drizzle/` migration, no `package.json`/`pnpm-lock.yaml`, no frontend, no CI, nothing under `app/backend/src/config.ts`, no Windows-settings or healthchecks.io or backup-task wiring anywhere — **18A/18B/18C untouched**. `git grep -n "hc-ping\|healthchecks" app/backend/src` → one hit only: a comment in `lib/heartbeat.ts:39`.

**Code structure (`file:line`):**
- `heartbeatConfigured()` at `app/backend/src/lib/heartbeat.ts:46-48` returns `heartbeatUrl() !== undefined` — the same lazy env-override-then-config resolver `pingHeartbeat()` uses (lines 26–30, 55), so `/health` cannot disagree with whether a ping would be sent.
- `/health` handler `app/backend/src/app.ts:129-179`: `heartbeat: { configured: heartbeatConfigured() }` at **173–175** — a boolean, nothing else in the object; **not** in `degraded` (line 152). `scheduler.enabled` (161), `scheduler.lastTickAt` (168) still present.
- Unit tests `test/lib/heartbeat.test.ts:95-128` (4 new: unset→false, set→true, boolean-never-URL via `JSON.stringify` substring assertions, agrees-with-ping-sent against an independent `fetch` mock). Integration `test/integration/health.test.ts:121-147` (2 new: `toEqual({configured:true})` + no URL/host/`HEARTBEAT_URL` anywhere in `JSON.stringify(res.body)`; false-when-unset). The as-built note's claim that the endpoint assertion *must* live in the integration project is correct — `pnpm test` runs the unit project only.
- **D12** (`rebuild/02-DECISIONS-AND-ARCHITECTURE.md`): heading + body record the as-built Windows-laptop host (Modern Standby, Docker-Desktop-after-login, Update-reboot-at-login-screen, work-PC second host, power-off pausing habit), the **hosting-undecided + host-agnostic** decision, and the **three move triggers** (second user; >1 missed day/month; phase-19 tunnel live) — matching the phase file verbatim in substance.
- **DEPLOY.md § 6.4** links (not performs) 18A–18C; its cross-references resolve (§ 6.3 SproutBackup task with `Register-ScheduledTask` at line 336; § 9 keys). **RUNNING.md** correctly replaces node-cron wording with the 15 s wall-clock tick, `SCHEDULER_ENABLED` default-false, pause-via-calendar, and the outside monitor.

**Doc currency (fetched 2026-10-14, current docs beat memory):**
- healthchecks.io *Configuring checks*: cron schedules take exactly "**Cron Expression**, **Server's Time Zone**, and **Grace Time**" — the field names RUNNING.md/DEPLOY.md use. Grace-Time semantics (late at the cron match, down after grace) match the docs. Ping URL = secret — matches the code comment's threat model.
- Docker Desktop settings reference: the General setting is verbatim "**Start Docker Desktop when you sign in to your computer**" — matches RUNNING.md/DEPLOY.md/phase file.
- Windows Update active hours: the **18-hour manual cap** and the path **Settings → Windows Update → Advanced options** are confirmed by current Microsoft sources (support.microsoft.com "keep your PC up to date with active hours"; learn.microsoft.com update-policies; Microsoft Q&A stating max 18 h). The "05:00–17:00" recommendation is a 12 h range — inside the cap.

**Live leak probe (independent of the test suite):** booted the backend on the work PC (`pnpm exec tsx src/index.ts`, port 3999, `DATABASE_URL` → `sprout_test`, `HEARTBEAT_URL=https://hc-ping.com/18d-TESTER-PROBE-secret-token-xyz`, `SCHEDULER_ENABLED` unset). `GET /health` → 200, body verbatim: `…"scheduler":{"enabled":false,…,"lastTickAt":null},"heartbeat":{"configured":true},…`. Substring checks on the raw body: no `18d-TESTER-PROBE`, no `hc-ping.com`, no `HEARTBEAT_URL`, no `secret-token-xyz`, **no `https://` at all**; `configured` parsed as Boolean. Server boot log contained none of the strings either. Process killed afterwards; nothing left running on :3999.

**Mutations performed to prove the new tests can fail (each restored; final `git diff` shows only the reported 18D change in `heartbeat.ts`, and the full suite re-ran green):**

| Mutation to `heartbeatConfigured()` | Unit result | Integration result |
|---|---|---|
| returns URL string (or `"unset"`) when set/unset — a leak | **4 red** (incl. `not.toContain("hc-ping.com")`) | **2 red** — failure diff shows `configured: "https://hc-ping.com/18d-secret-uuid-heartbeat"` reaching the body |
| returns the URL when set, `false` when unset | **3 red** | **1 red** (the configured-true test) |
| forced `true` | **2 red** (unset→false, agrees) | **1 red** (configured false-when-unset) |
| forced `false` | **2 red** (set→true, agrees) | **1 red** (configured true-when-set) |

Every one of the 6 new tests was shown to be able to fail; none is vacuous. The "agrees" test cross-checks against an independent `fetch` mock (not against the config the code reads), so it is not the self-deriving kind.

---

## B — defects

**B1 — minor (non-blocking): RUNNING.md's new sentence names a job class that no longer exists.** The rewritten "For it to fire" says the tick "fires the slots, retries, the missed-run sweep **and the nightly jobs**". The only tick handlers registered are `onTick("scheduler", …)` (`services/scheduler.ts:303` — slots + 5-min sweep) and `onTick("retries", …)` (`services/run-lifecycle.ts:509`); the one true nightly job (03:00 Gazette refresh) was **deleted in phase 16**, and `startScheduling`'s own log line says "daily slots, retries and the missed-run sweep are armed". Failure scenario: an operator reading RUNNING.md waits for a nightly job that will never come, or files a bug when none appears. The identical stale phrase sits pre-existing in `config.ts:135` / `index.ts:73` comments (outside this diff). Fix is a word-level edit; reviewer can fold it into the commit or queue it.

**B2 — process caution (reviewer must stage by name): two unreported working-tree changes are NOT 18D and one is security-relevant.** `.opencode/agent/orchestrator.md` changes the orchestrator's bash permission from `"*": deny` to `"*": allow`, and `opencode.json` changes the permission schema. The implementer disclaimed both ("not mine") and I cannot attribute uncommitted changes — but a blanket `git add -A` would ship a permission widening with the phase. **Stage exactly the nine 18D files by name.** Also untracked and not to be committed: two stray HRHub capture artifacts at the repo root (`screencapture-kmcsolutions-hrhub-…png`, `view-source_…EmployeeDashboard.aspx.html`), likewise disclaimed.

**B3 — minor: the empty-string edge is unasserted.** Compose emits `HEARTBEAT_URL=""` for an unset key; `heartbeatUrl()` and `config.ts` both treat `""` as unset (so `configured` will be `false` — behaviour is right), but no test pins `""` → `false` directly. A future refactor of the resolver could regress it silently. Non-blocking; suggested as one extra `it` row.

No secret leak (proved above). No auth/tenant surface added (`/health` remains unauthenticated by design; the new field is an aggregate boolean — no per-user data). No new config key (`HEARTBEAT_URL` is pre-existing from 12D, already in `config.ts`, `.env.example` and both compose files). No migration, no dependency added.

---

## C — what I could not verify, and why

1. **A real healthchecks.io check** — account creation, the cron schedule UI round-trip, grace time, and alert delivery (email + Telegram/phone) cannot be exercised from here; I was instructed never to contact healthchecks.io. The docs-currency check above covers the *wording*; the *behaviour* waits on § 18B.
2. **The laptop's overnight behaviour** — Verification Gate rows 1–3 (lid-closed run on time; backend-stopped alert within grace; two pings a day) need the scheduled laptop (`ORCHARD-MGETUTUA`) and a real 05:30/16:15 slot. Untestable on the work PC.
3. **The `SproutBackup` scheduled task and a rehearsed restore** (18C, Verification Gate row 4) — operator work on the laptop; I never touch scheduled tasks or the live database.
4. **Work-PC `/health` live check (Verification Gate row 5)** — the work PC has **no backend container running right now** (`docker compose ps` shows only `sprout-postgres`). My :3999 tsx boot demonstrated the exact response shape (`scheduler.enabled:false` when `SCHEDULER_ENABLED` is unset), but that is not the dockerised deployment the row means. **Row 5 stays unconfirmed.**
5. **Attribution of the `.opencode` / `opencode.json` changes** (B2) — uncommitted working-tree state has no author; the reviewer/operator must decide whether they are intentional.
6. **Dependency currency beyond "no additions"** — `pnpm outdated` currently shows behind-latest: `playwright` 1.60.0→1.64.0 (note: AGENTS.md pins "Playwright 1.60" as the spec version, so this may be deliberate), `express-rate-limit` 7.5.1→8.7.1 (major), `pino` 9.14→10.4 (major), `pino-http` 10.5→11 (major), `imapflow` 1.7.2→2.4.0 (major), `@types/node` 22→26 (major), plus minors (`express` 5.2.1→5.3.0, `helmet` 8.2→8.3, `pg` 8.22→8.23, `date-holidays` 3.35→3.37, `mailparser` 3.9.15→3.9.38, `oxlint` 1.71→1.87, `tsx` 4.22→4.23, `vite` 8.2→8.3). 18D correctly **did not** bump anything mid-phase; per AGENTS.md these are reported, and the reviewer decides whether any becomes a follow-up.
7. **A real Telegram/HRHub/Cloudflare path** — untouched by 18D; still covered by earlier phases' outstanding `[manual]` rows.

---

## D — `[manual]` checks (operator; results column deliberately empty)

Carried from the phase file's Verification Gate and § 18A–18C. Nothing here is claimed passed.

| # | Check | Exact command / click sequence | Pass looks like | Results |
|---|---|---|---|---|
| 1 | Laptop power (18A) | Settings → System → Power: plugged-in sleep = **Never**; lid close = **Do nothing** | Laptop survives lid-closed overnight | |
| 2 | Docker Desktop on login (18A) | Docker Desktop → Settings → General → **"Start Docker Desktop when you sign in to your computer"** ON | After reboot + login, containers self-restart | |
| 3 | Windows Update active hours (18A) | Settings → Windows Update → Advanced options → Active hours → manual **05:00–17:00** (≤ 18 h range) | No Update reboot attempted inside the clocking window | |
| 4 | Stop pausing by power-off (18A) | Use Schedule panel's calendar skip days / pause range for time off instead of powering off; weekend power-off OK (monitor is Mon–Fri) | Next intended pause done via calendar | |
| 5 | healthchecks.io check created (18B) | New check: **Cron** `15 5,16 * * 1-5`, **Server's Time Zone** `Asia/Manila`, **Grace Time** 45 min; integrations: email + Telegram or phone app | Check visible, state New/Up | |
| 6 | `HEARTBEAT_URL` armed (18B) | Put the ping URL in the **laptop's** `.env`; `docker compose up -d --build backend` **outside 05:15–05:45 and 16:00–16:30**; then `curl --noproxy '*' http://127.0.0.1:3000/health` | `"heartbeat":{"configured":true}`; body contains no URL | |
| 7 | Dead-man's-switch proven (18B / Gate row 2) | On a test day, stop the backend before a slot (or point the check at a near time); wait past grace | Alert arrives by email **and** phone/Telegram within the grace window | |
| 8 | A normal day (Gate row 3) | Leave the stack running one weekday; open healthchecks.io | Two pings, ~05:31 and ~16:16, check stays Up | |
| 9 | Lid-closed overnight (Gate row 1) | Laptop plugged in, lid shut overnight; next morning: `docker compose exec postgres psql -U sprout -d sprout -c "SELECT started_at, status FROM runs ORDER BY started_at DESC LIMIT 4;"` | 05:30 run exists; `lateByMs` < 15 000 in the log | |
| 10 | SproutBackup task (18C / Gate row 4a) | Task Scheduler → find **SproutBackup** → check "Last Run Result" / `Get-ScheduledTaskInfo -TaskName SproutBackup` | Ran today; result 0 | |
| 11 | Backup off-machine + restore rehearsed (18C / Gate rows 4b–c) | Confirm newest dump in the synced off-machine folder; restore it once into a scratch DB per DEPLOY.md § 6.2; record the date in STATE.md | Restore succeeds; date recorded | |
| 12 | Stray dumps retired (18C item 5) | Delete `$HOME\sprout-backup-.sql` and the 09-10 dump from `$HOME` once 10–11 pass | Files gone | |
| 13 | Key custody (18C item 3) | `APP_ENCRYPTION_KEY` + `SESSION_SECRET` stored in the password manager, **not** in the backup folder | Confirmed by operator | |
| 14 | Work-PC `/health` (Gate row 5) | On the work PC with its backend running: `curl --noproxy '*' http://127.0.0.1:3000/health` | `"scheduler":{"enabled":false,…}` — **note: no backend container is currently running on the work PC, so this is unconfirmed** | |

---

*Mutation note: `heartbeatConfigured()` was temporarily mutated four times to prove the tests can fail (section A). `git diff` on `app/backend/src/lib/heartbeat.ts` at the end of this round shows only the implementer's original 18D addition; the full suite re-ran green (326 / 190). No other file was edited; the probe server was killed; the only file this round leaves changed is this addendum.*
