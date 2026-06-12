# Phase 5 — Deploy & Ops

**Goal:** get the stack onto a VPS behind TLS, with backups and a sane day-2 routine. The original `DEPLOY.md` is the long-form runbook; this phase is the spec for the deploy artifacts and the hardening checklist.

**Attach for this session:** `04-STACK-SCAFFOLD-AND-CONFIG.md`.

**Phase 4A must be done before any real user signs up.** Phase 4B before inviting more than a couple of people.

---

## 5.1 — Target

- **Hetzner CPX11** (2 GB RAM, 2 vCPU, 40 GB NVMe), **Singapore** (lowest latency to Manila HRHub), Ubuntu 24.04, ~$5/mo.
- Rejected: RackNerd (flaky), DigitalOcean (overpriced). Don't undersize RAM — each Chromium is ~300 MB and `MAX_CONCURRENT_RUNS=3`.

## 5.2 — VPS hardening checklist

- Create a non-root sudo user; copy SSH keys to it.
- Disable root SSH login and password auth (`PermitRootLogin no`, `PasswordAuthentication no`), restart ssh.
- `unattended-upgrades` + `fail2ban` enabled.
- UFW: deny incoming except `22/80/443`; allow outgoing. (Plus the Hetzner Cloud Firewall as belt-and-braces.)
- `chmod 600 .env`.
- App bound behind the reverse proxy (not exposed directly in prod — see 5.4).

## 5.3 — Production Dockerfile

Use the multi-stage `Dockerfile` from `04` verbatim. Key properties to preserve:
- Stage 1 `node:20-alpine` builds the **frontend** → `dist`.
- Stage 2 `mcr.microsoft.com/playwright:v1.49.1-noble` (must match the pinned `playwright@1.49.1`) installs backend prod deps, copies `src`/`drizzle`/`tsconfig`/`drizzle.config.ts`, copies the frontend `dist` → `./public`.
- Creates `/app/data`, `chown` to `pwuser`, runs as **non-root `pwuser`**.
- `CMD ["npx","tsx","src/index.ts"]` — runs TypeScript directly, no compile.

## 5.4 — Caddy TLS overlay

`docker-compose.prod.yml` adds a `caddy:2-alpine` container (ports 80/443, mounts `./Caddyfile` + data/config volumes, on `sprout-net`) and overrides the backend service to **stop publishing port 3000** (`ports: !reset []`) so only Caddy reaches it.

`Caddyfile` (domain mode):
```
sprout.yourdomain.com {
    encode gzip
    reverse_proxy backend:3000
}
```
IP-only mode: `:443 { tls internal\n encode gzip\n reverse_proxy backend:3000 }`.

Bring up: `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build`, then `docker compose exec backend npm run db:migrate` (first time / when migrations change).

## 5.5 — Backups

- Nightly `pg_dump -Fc` (custom format) inside the Postgres container, gzipped to `~/backups`, retained ~14 days, via host `crontab` at 03:00 `TZ=Asia/Manila`.
- ⚑ Recommended: an **off-host encrypted** copy (rsync to a second host or S3, encrypted with `age`/`gpg`).
- Document and **test** the restore path (`pg_restore --clean --if-exists`) at least once.

## 5.6 — Day-2 operations

- Logs: `docker compose logs -f backend` (greppable for `error`). ⚑ If you adopted `pino`, ship logs to a free tier (Axiom / Better Stack) for searchability.
- Update: `git pull` → rebuild → migrate-if-changed.
- Free uptime check: UptimeRobot against `https://host/health`.
- ⚑ Recommended ops add-on: a `data/` cleanup job for old per-user screenshots/sessions (the as-built repo defers this) — a cron that prunes `screenshots/<userId>/<runId>` older than N days keeps the volume from growing unbounded.

## 5.7 — Onboarding a colleague

Until Phase 4B email verification ships: share the URL privately, they sign up + follow the in-app Gmail walkthrough + "Test Gmail connection", set a schedule, do one manual "Clock in now" to confirm the full path against real HRHub. The DB partial unique index guarantees one user's runs never collide with another's.

---

## Verification Gate

1. `https://your-host/health` returns `{"status":"ok","db":"ok"}` over **valid TLS** (or `tls internal` self-signed in IP mode).
2. The backend port (3000) is **not** reachable from the public internet — only Caddy is.
3. Sign up on the live host, configure creds, **Test Gmail connection succeeds**, save a schedule, run a manual clock-in that reaches real HRHub.
4. The next weekday morning, the scheduled run fires (check `runs` history / logs) — or simulate by setting a near-future `clockInTime`.
5. A `pg_dump` backup file is produced by the cron and a test restore into a scratch DB succeeds.

Commit the deploy artifacts as you add them (e.g. `chore(phase-5): prod dockerfile + caddy tls overlay`, `chore(phase-5): pg_dump backup cron`), all on green checks; then tag `git tag phase-5-complete`. (You run the commits, not the agent.)

When these pass you have a defensible, production-ish v1. Phase 6 (TOTP 2FA, admin impersonate-with-audit, public status page) is ongoing polish.
