# Phase 12 — Durability and observability on a workstation host

**Goal:** be able to recover the database, and find out when the stack has stopped. Neither is true today.

**Why this phase exists.** Every deploy artifact in this repo was written for a **Hetzner VPS running Linux** (`phases/phase-5-deploy-ops.md`, `DEPLOY.md`). The actual deployment became a **Windows laptop** (`BACKLOG.md` § 12), and nothing was re-derived after that move. The backup script cannot run, the health endpoint cannot fail, and the only thing that would alert you lives inside the process that breaks.

**None of this needs the domain.** Do it before `BACKLOG.md` § 12 — it protects data you already hold, for people who have already trusted you with credentials.

**Attach for this session:** `03-CONVENTIONS-AND-GUARDRAILS.md`, `phases/phase-5-deploy-ops.md` (§ 5.5 backups, § 5.6 day-2 ops — the Linux originals), `reference/crypto-and-otp-specs.md` (§ encryption, for 12C), `reference/testing-strategy.md`.

> 📡 **Fetch live docs (Context7):** Docker Compose `logging` driver options, `node-cron` for the 12D hook point, and the heartbeat service's ping contract if one is chosen. Do not write these from memory.

**Scope discipline.** This phase adds no feature a user can see. Do not build the admin surface (phase 10), do not touch the run history (phase 9), do not bump dependencies (phase 11). If a change here needs a config key, it goes into `config.ts`, `.env.example` **and both compose files** in the same gate — phase 8 § 8A exists because that was missed once.

---

## 12A — `/health` tells the truth

**The defect.** `app/backend/src/app.ts:97-112` returns `status: "ok"` **unconditionally**. Only the `db` field reflects reality:

```ts
res.json({
  status: "ok",            // <-- hardcoded, can never say otherwise
  service: "sprout-automator-backend",
  db: dbStatus,            // <-- the only honest field
  ...
});
```

So a backend that boots, fails to register a single cron schedule, and never runs again answers **HTTP 200 `{"status":"ok"}`** forever. Any uptime monitor pointed at it — including the one `phase-5-deploy-ops.md` § 5.6 recommends — is decorative. This is the "a test that cannot fail is worse than no test" rule applied to an endpoint, and **12D is worthless until it is fixed.**

**Contract:**
- `status` becomes derived, not literal: `"ok"` only when every check passes, otherwise `"degraded"`.
- **Respond `503` when a check fails**, `200` otherwise. A monitor must be able to detect failure from the status code alone, without parsing the body — most free monitors only check the code.
- Add a `scheduler` object: the **number of registered cron schedules** and the **timestamp of the last scheduler fire** (any user, any action). A backend with users who have enabled schedules but `registered: 0` is broken, and today nothing says so.
- Add the run-queue depth from the existing `runQueue.stats()` (already exposed at `routes/runs.ts:60`) so a wedged queue is visible.
- **Do not add authentication and do not put it behind a limiter** — it stays unauthenticated and unthrottled, as `app.ts:73` documents. It must also **leak nothing**: no user emails, no counts that identify individuals, nothing derived from a secret.
- `db: "down"` must produce a 503. That is the case that exists today and reports healthy.

**Tests (integration):**
- Healthy: 200, `status: "ok"`, `scheduler.registered` matches the number of enabled schedules.
- **Unhealthy: point the pool at a dead database and assert 503 with `status: "degraded"`.** This test must fail against the current code — that is the whole gate.
- `registered: 0` with at least one enabled schedule in the database is reported as degraded.
- The response body contains no email address and no secret.

**Gate 12A:** `cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration`

---

## 12B — A backup that can actually run on this host

**The defect.** `scripts/backup.sh` is bash and its own header says to install it with `crontab -e`. The host is **Windows**; there is no crontab, and no `backup.ps1` exists. **The script has never run.** Meanwhile the Postgres data lives in a Docker named volume (`sprout-pgdata`) on a laptop that leaves the house, and it holds every user's AES-256-GCM-encrypted Sprout password and Gmail App Password.

If that disk dies today, every user re-enters credentials they may no longer have.

**Contract:**
- **`scripts/backup.ps1`** — a functional twin of `backup.sh`, not a rewrite. Same `pg_dump -Fc` custom format into the running container, same gzip, same `BACKUP_DIR` default, same `RETENTION_DAYS` prune. The `setup.ps1` / `setup.sh` pair is the established precedent for this shape; follow it.
- **Install as a Windows Task Scheduler job**, documented in the script header the way `backup.sh` documents its crontab line. Give the exact `Register-ScheduledTask` invocation, and state that the task must be set to **run whether or not the user is logged on** — otherwise it inherits the same Docker-Desktop-needs-a-session problem that is already the largest risk on this host.
- `docker exec -T` was removed in Docker 29.5 (`phase-5-deploy-ops.md` § 5.4 as-built) — use `-i` for stdin. The `.sh` twin already gets this right; do not regress it in the PowerShell version.
- **`scripts/restore.ps1`** as well. A backup nobody can restore is a filing cabinet.
- **`DEPLOY.md` gains a "workstation host" section.** That document currently only knows about a VPS behind Caddy; a reader following it on Windows gets Linux instructions for a topology that no longer applies.

**Gate 12B:**
```
pwsh -NoProfile -Command "$null = [ScriptBlock]::Create((Get-Content -Raw ./scripts/backup.ps1))"
cd app/backend && pnpm lint && pnpm typecheck && pnpm test
```

Most of 12B is `[manual]` by nature — see the table at the end. **Do not claim a backup works because the script parses.**

---

## 12C — Key custody, written down

**The gap nobody has stated.** `APP_ENCRYPTION_KEY` lives in the root `.env`. Two consequences, neither documented nor decided:

1. **A database backup without that key is unrecoverable.** Every `*_enc` column is AES-256-GCM ciphertext; the key is not in the dump.
2. **A backup stored next to the key is a single-file compromise** of every user's Sprout and Gmail credentials. So "back up `.env` alongside the dumps" — the obvious move — is the wrong one.

There is also no rotation path. If the key is ever exposed, there is no way to re-key the data.

**Contract — documentation first, code only if cheap:**
- A new section in `DEPLOY.md`: where the key lives, that it must be stored **separately** from the database dumps (a password manager is the realistic answer for a one-operator deployment), and the explicit statement that **losing it means every user re-enters their credentials** — there is no recovery.
- Document the **rotation procedure**: decrypt every `*_enc` column with the old key and re-encrypt with the new, in one transaction, with the app stopped.
- **Build `scripts/rotate-key.ts` only if it is genuinely small.** It must import from `lib/encryption.ts` — the only module allowed to touch `*_enc` columns (AGENTS.md rule 7) — take the old and new keys explicitly rather than reading ambient env, and **refuse to run unless it can take a backup first**. If it cannot be done in a contained way, **write the manual procedure and stop.** A half-built re-keying script is more dangerous than none.
- Whatever is built or documented: **never log a key, a plaintext credential, or a ciphertext** (rule 4).

**Gate 12C:** the documentation exists and is accurate. If the script was built: `pnpm typecheck` passes and a unit test proves a round-trip re-key preserves plaintext for a fixture row.

---

## 12D — A dead-man's-switch, because the alarm currently dies with the patient

**The defect.** Missed-run reconciliation (phase 6, D17) is the only thing that tells you a run did not happen — and it runs **inside the app**, on the same `node-cron` scheduler it is watching. If Docker Desktop is down after a Windows Update reboot (the known largest risk on this host, recorded in `BACKLOG.md` § 12), the sweep is dead too. **The failure mode is silence, and silence is indistinguishable from success.**

**The pattern.** Invert it: the app pings **outward** on every scheduler fire, and an external service alerts when the pings **stop**. That needs no inbound URL, no public hostname and no certificate — so unlike the UptimeRobot suggestion in `phase-5-deploy-ops.md` § 5.6, **it is not gated on buying a domain.**

**Contract:**
- New **optional** config key `HEARTBEAT_URL` (`z.string().url().optional()`, through the existing `emptyToUndefined` preprocess in `config.ts`). Unset means the feature is off: no requests, no warnings. Add it to `config.ts`, `.env.example` **and both compose files** in this gate.
- Ping on **every scheduler fire** — the place that proves cron is alive, not process start. `services/scheduler.ts` is the hook point.
- **Fire-and-forget, and it must never affect a run.** Same contract as notifications (AGENTS.md rule 11): a dead heartbeat endpoint must not change a run's status, timing, or any HTTP response. Use the sanctioned `.catch(() => {})` cleanup idiom (rule 2) and nothing more elaborate.
- Give it a **short timeout** (a few seconds) so a hanging endpoint cannot delay a clock-in. That is the failure mode which would turn a monitoring feature into an outage.
- **Never put anything identifying in the ping** — no email, no user id, no run id in a query string. A third party learning your team's clock-in times is a privacy leak for other people, not just you.

**Tests:**
- `HEARTBEAT_URL` unset → zero outbound requests.
- Set → a scheduler fire pings the URL exactly once.
- **A heartbeat endpoint that rejects or hangs does not fail, delay or alter the run** — assert the run's status and that the scheduler completed. This is the test that matters; model it on `notification-isolation.test.ts`, which asserts the same property for Telegram.
- The request carries no user-identifying data.

**Gate 12D:** `cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration`

---

## 12E — Log rotation

**The defect.** Neither `docker-compose.yml` nor `docker-compose.prod.yml` sets any `logging` options, so both services use Docker's default `json-file` driver with **no size limit**. `pino` logs every request and `pino-http` logs full headers. On a host meant to run unattended for months that grows without bound, on the same disk as the screenshots `BACKLOG.md` § 2 already flags.

**Contract:**
- Add `logging.driver: json-file` with `options.max-size` and `options.max-file` to **both** services in **both** compose files. Pick modest values (e.g. `10m` x `3`) and say why in a comment.
- Confirm `docker compose config` still renders cleanly and emits **zero** `is not set` warnings — phase 8 § 8A worked hard for that and this must not regress it.

**Gate 12E:**
```
docker compose config > /dev/null && docker compose config 2>&1 | grep -c "is not set"   # must be 0
docker compose -f docker-compose.yml -f docker-compose.prod.yml config > /dev/null
```

---

## Verification Gate (the whole phase)

```
cd app/backend  && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration
cd app/frontend && pnpm lint && pnpm test && pnpm build
docker compose config 2>&1 | grep -c "is not set"
python -c "import yaml;yaml.safe_load(open('.github/workflows/ci.yml'))"
```

Baselines to preserve: **161 backend unit / 106 backend integration / 5 frontend unit / 16 e2e.** Higher is expected here; *lower* is a finding.

**`[manual]` — must not be claimed as passed:**

| # | Check | Pass looks like |
|---|---|---|
| 1 | Stop Postgres, hit `/health` | **HTTP 503**, `status: "degraded"`, `db: "down"` — the case that reports healthy today |
| 2 | Start everything, hit `/health` | 200, and `scheduler.registered` equals the number of enabled schedules |
| 3 | Register `backup.ps1` in Task Scheduler and let it fire | A `.gz` dump appears in the backup directory, at a plausible size |
| 4 | **Restore that dump into a scratch database** | Tables, indexes and row counts match — including the partial unique index. A dump nobody restored is not a backup |
| 5 | Reboot Windows, do not log in, wait for the backup window | The task still ran — proves "run whether or not the user is logged on" |
| 6 | Set `HEARTBEAT_URL` to a real endpoint, wait for a scheduler fire | The external service records the ping and shows the expected schedule |
| 7 | Point `HEARTBEAT_URL` at a black hole, then run a real clock action | The run completes normally and on time — the heartbeat must be incapable of hurting it |
| 8 | `docker compose logs backend --tail 5` after a day of running | Logs present, and the on-disk log file is bounded |

Commit per the loop in `AGENTS.md` — implementer reports, tester probes, reviewer commits. Tag `phase-12-complete` when the `[manual]` table is filled in, which needs a reboot and a real restore.
