# Phase 18 — Host reliability and outside alerting

> 🧑 **Operator-led.** Almost all of this is Windows settings, a third-party account and a scheduled task. An orchestrator does the small code and doc half (§ 18D) and stops.

**Goal:** the laptop is awake, logged in as far as Docker needs, and running the stack at 05:30 and 16:15. When it isn't, something **outside the laptop** tells you within the hour. Run history survives a dead disk.

**Why this exists.** The 2026-10-14 architecture review found that **D12 was never re-derived for the real host**. D12 describes an always-on Hetzner VPS. The real host is a Windows work laptop:
- It uses Modern Standby and hibernate.
- Docker Desktop starts only **after an interactive login**.
- A Windows Update reboot leaves it at the login screen.
- A second machine (the work PC) runs the same app with its own database.
- The operator pauses it by **powering it off** after Friday's clock-out and over holidays.

All of the app's alerting runs **inside** that process, over one channel (Telegram), so a host that is down can't report itself. 09-28's missed clock-in was alerted at 16:50, eleven hours late, and only because the host came back.

**Decided 2026-10-14:**
- **The long-term host is undecided.** Keep the laptop and make it as reliable as it can be. Keep everything host-agnostic (compose plus `.env`), so moving to an always-on box later means following `DEPLOY.md`.
- **Only the laptop schedules** (`SCHEDULER_ENABLED`, phase 15D).
- **Late wake: alert only** (phase 15C).

**Depends on phase 15** (heartbeat on outcome; `SCHEDULER_ENABLED`). It can run alongside phases 16 and 17.

> 🆕 **LATEST, UP-TO-DATE TECH, CODE AND REFERENCES. Mandatory.** Windows, Docker Desktop, WSL and healthchecks.io settings change between releases: follow their **current** official docs, not this spec's wording or memory. Full rule: `AGENTS.md` hard rule 1.

---

## 18A — Keep the laptop able to run `[manual]`

**Steps** (verify each one; Windows UIs change between builds):
1. **Power:** when plugged in, *never sleep*, and lid close set to *do nothing*. `RUNNING.md` already says this, but its reason still names node-cron, so fix the wording in 18D.
2. **Docker Desktop:** Settings → General → *Start Docker Desktop when you sign in* stays on. **It cannot start before a login**, which is the known gap. The options, in order of effort:
   - **(a)** Accept it, and let the outside monitor (18B) catch the Windows Update reboot case. Set Windows Update *active hours* to cover 05:00–17:00 so restarts happen outside them.
   - **(b)** Run Docker Engine inside a WSL distro with systemd, started at boot by a Task Scheduler task *"run whether user is logged on or not"*. This removes the login dependency, but it replaces Docker Desktop on this machine. Its own phase if you choose it.
   - **(c)** Move the scheduler to an always-on host (D12's original plan).

   **Default: (a).** Record the choice in STATE.md.
3. **Stop pausing by power-off.** Use the phase-16 calendar (skip days) or a pause range instead. A powered-off laptop is indistinguishable from a broken one, and the outside monitor will alert on it. Weekends are fine, since the monitor's schedule is Mon–Fri.

---

## 18B — An outside dead-man's switch `[manual]`

1. Create a free account at **healthchecks.io**.
2. Create a check:
   - Schedule: **Cron**, expression `15 5,16 * * 1-5`.
   - Time zone: **Asia/Manila**.
   - Grace: **45 minutes**.

   The app pings when a scheduled slot reaches an **outcome** (success, deliberate skip, or give-up; phase 15A). So "no ping by 06:00 / 16:45 on a weekday" means *nothing reached an outcome*: the host is down, the app is down, or a run is still failing.
3. Integrations: email (the default) plus **Telegram or the phone app**. This gives an alert path that doesn't depend on the laptop or on the app's own bot token.
4. Put the ping URL in the laptop's `.env` as `HEARTBEAT_URL` and restart the backend **outside 05:15–05:45 and 16:00–16:30**.
5. Prove it: stop the backend before a slot on a test day (or point the check's schedule at a near time), and confirm the alert arrives.

---

## 18C — Backups that survive the laptop `[manual]`

1. Register `scripts/backup.ps1` as the **SproutBackup** scheduled task, exactly as `DEPLOY.md` § Windows describes, daily at a time the laptop is on (e.g. 12:00; **not** 03:00, when the laptop may be off).
2. Point `BACKUP_DIR` at a folder that syncs off the machine (OneDrive or similar), **not** next to `.env`.
3. Keep `APP_ENCRYPTION_KEY` and `SESSION_SECRET` in a password manager, **separate from the dumps** (DEPLOY.md § keys: a backup without the key is unrecoverable, and a backup next to the key is a single-file compromise).
4. Restore the newest dump into a scratch DB once, and record the date in STATE.md. An untested backup is not a backup.
5. Delete the stray manual dumps in `$HOME` (`sprout-backup-.sql` with an empty date, and the 09-10 dump) once the scheduled backup has been proven.

**Why it matters here:** the run history is your evidence in an HR dispute like 2026-08-21.

---

## 18D — Code and docs (orchestrator)

- `RUNNING.md` § "For it to fire": drop the node-cron wording. Describe the tick, `SCHEDULER_ENABLED`, the outside monitor, and pausing with the calendar instead of power-off.
- `DEPLOY.md`: add a short "Windows laptop host" section that links 18A–18C, so the VPS runbook isn't the only story.
- **Revise D12** in `02-DECISIONS-AND-ARCHITECTURE.md`: the as-built host, the decision that hosting is undecided and must stay host-agnostic, and the conditions that would trigger a move to an always-on host. Those conditions are: a second user depending on it; more than one missed day a month caused by the host; or phase 19's tunnel going live.
- `/health` already reports `scheduler.lastTickAt` and, from phase 15, `scheduler.enabled`. Add `heartbeat.configured: boolean` (never the URL).

**Gate 18D:** `cd app/backend && pnpm lint && pnpm typecheck && pnpm test` · `docker compose config 2>&1 | grep -c "is not set"` must be `0`

---

## Verification Gate

| # | Check | Pass looks like |
|---|---|---|
| 1 | Laptop plugged in with the lid closed overnight | 05:30 run fires on time (`lateByMs` < 15 000) |
| 2 | Backend stopped across a slot (test day) | healthchecks.io alert arrives by email and phone within the grace window |
| 3 | A normal day | healthchecks.io shows two pings, ~05:31 and ~16:16 |
| 4 | SproutBackup task | Ran today; the dump is in the off-machine folder; one restore tested and dated in STATE.md |
| 5 | Work PC `/health` | `scheduler.enabled: false` |

Tag `phase-18-complete` when the table is filled in.
