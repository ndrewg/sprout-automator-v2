# Phase 5 — Deploy & Ops

**Goal:** get the stack onto a VPS behind TLS, with backups and a sane day-2 routine. The original `DEPLOY.md` is the long-form runbook; this phase is the spec for the deploy artifacts and the hardening checklist.

**Attach for this session:** `04-STACK-SCAFFOLD-AND-CONFIG.md`, `reference/supply-chain-and-ci.md`, `reference/live-docs-and-mcp.md`.

> 📡 **Fetch live docs first (Context7):** Caddy v2 (Caddyfile, reverse_proxy, auto-TLS), Docker Compose (current spec), pnpm in Docker. Verify the prod Dockerfile/compose against current docs.

**Phase 4A must be done before any real user signs up.** Phase 4B before inviting more than a couple of people.

---

## 5.1 — Target

- **Hetzner CPX21** (**4 GB** RAM, 3 vCPU, 80 GB NVMe), **Singapore** (lowest latency to Manila HRHub), Ubuntu 24.04, ~$8/mo.
- **Why 4 GB, not the 2 GB CPX11:** each Chromium is ~300 MB and `MAX_CONCURRENT_RUNS=3`, plus Postgres (~150 MB) + Node + Caddy. On 2 GB the 5:30 AM stampede risks an OOM-kill; 4 GB gives real headroom. If you ever do run on 2 GB, drop the cap to **2**.
- Keep `MAX_CONCURRENT_RUNS=3` (or 4) on the 4 GB box. Don't raise it without watching memory.
- Rejected: RackNerd (flaky), DigitalOcean (overpriced).

## 5.2 — VPS hardening checklist

- Create a non-root sudo user; copy SSH keys to it.
- Disable root SSH login and password auth (`PermitRootLogin no`, `PasswordAuthentication no`), restart ssh.
- `unattended-upgrades` + `fail2ban` enabled.
- UFW: deny incoming except `22/80/443`; allow outgoing. (Plus the Hetzner Cloud Firewall as belt-and-braces.)
- `chmod 600 .env`.
- App bound behind the reverse proxy (not exposed directly in prod — see 5.4).

## 5.3 — Production Dockerfile

Use the multi-stage `Dockerfile` from `04` / `reference/supply-chain-and-ci.md` verbatim. Key properties to preserve:
- Stage 1 **`node:22-bookworm-slim`** builds the **frontend** with pnpm (`pnpm install --frozen-lockfile` → `pnpm build`) → `dist`. **Debian, not Alpine** — Tailwind v4's native engine (Oxide/lightningcss) has musl friction. (This line previously said `node:22-alpine`, contradicting doc `04`, the supply-chain reference, and the as-built Dockerfile; following it would break the build.)
- Stage 2 `mcr.microsoft.com/playwright:v1.60.0-noble` (**must match the pinned `playwright@1.60.0`**) installs backend prod deps via `pnpm install --frozen-lockfile --prod`, copies `src`/`drizzle`/`tsconfig`/`drizzle.config.ts`, copies the frontend `dist` → `./public`.
- Creates `/app/data`, `chown` to `pwuser`, runs as **non-root `pwuser`**.
- `CMD ["pnpm","exec","tsx","src/index.ts"]` — runs TypeScript directly, no compile.

## 5.4 — Caddy TLS overlay

`docker-compose.prod.yml` adds a `caddy:2-alpine` container (ports 80/443, mounts `./Caddyfile` + data/config volumes, on `sprout-net`) and overrides the backend service to **stop publishing port 3000** (`ports: !reset []`) so only Caddy reaches it.

`Caddyfile` (domain mode):
```
sprout.yourdomain.com {
    encode gzip
    reverse_proxy backend:3000
}
```
IP-only mode: **use `localhost { tls internal ... }`**, not `:443 { tls internal }` — Caddy's certificate automation only issues for named hostnames, so a bare port has no hostname and cert issuance fails.

Bring up: `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build`, then `docker compose exec backend pnpm db:migrate` (first time / when migrations change).

**As-built note (2026-08-08):** `Caddyfile` ships with both modes (domain + localhost); docker-compose.prod.yml uses `ports: !reset []` to stop the backend publishing 3000; Caddy ports are parameterized via `CADDY_HTTP_PORT` / `CADDY_HTTPS_PORT` env vars (defaults 80/443) so local testing on different ports is straightforward. `docker exec -T` was removed in Docker 29.5 — scripts use `-i` for stdin piping instead.

## 5.4b — Production environment (⚠️ this section postdates the original doc)

Phases 6, 7, 4A.2, 4B and L each added config keys. `config.ts` is the authority; this is the deploy-time summary.

**Hard-required — the app refuses to boot without them:**
`DATABASE_URL`, `APP_ENCRYPTION_KEY` (64 hex chars), `SESSION_SECRET` (≥32 chars).

**Required in production specifically:**
- `NODE_ENV=production` — defaults to `development`, so the prod compose must set it explicitly rather than inherit from `.env`. Under `development` the session cookie is not `Secure`; under `production` it is, which is what you want behind Caddy.
- `SIGNUP_ALLOWED` — already refuses to boot when empty in production (4A.2). Set it to the team domain plus any exact addresses.

**⚠️ `APP_URL` is the silent one — fix this in the code, not just the runbook.** It defaults to `http://localhost:3000`. In production the app boots fine and everything appears to work, but **every password-reset and email-verification link points at localhost**, so a colleague clicking one gets nothing. Nothing warns, because a default exists.
**Requirement for this phase:** extend `config.ts` so that in production an `APP_URL` whose host is `localhost` or `127.0.0.1` **refuses to start**, with a message naming the fix — the same shape as the existing `SIGNUP_ALLOWED` production guard. An invisible failure becomes a startup error.

**Optional but worth setting:**
- `RESEND_API_KEY` + `MAIL_FROM` — without them, reset and verification emails only reach the server log. The app is usable without mail; password reset effectively is not. Note the free tier needs one verified domain (see `BACKLOG.md` § 9).
- `SPROUT_URL`, `MAX_CONCURRENT_RUNS` (drop to 2 on a 2 GB box), `MISSED_RUN_GRACE_MINUTES`, `AUTH_RATE_LIMIT` (raise if the team shares one NAT — `BACKLOG.md` § 3), `TZ=Asia/Manila`, `DATA_DIR`.

**Not a config item, already handled:** `pino-pretty` is a devDependency the image's `--prod` install omits, so the logger guards the pretty transport (commit `60b99d6`). Don't reintroduce an unguarded transport.

`DEPLOY.md` must carry this table, and the gate must prove the `APP_URL` guard fires.

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
