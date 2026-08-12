# DEPLOY.md — Sprout Automator production runbook

Phase 5. The goal: the stack on a VPS behind TLS, with backups and a sane
day-2 routine. Read `rebuild/phases/phase-5-deploy-ops.md` for the reasoning
behind every choice here; this file is the followable runbook.

> **No VPS yet?** Almost all of this is verifiable on one machine. Caddy's
> `tls internal` issues a self-signed certificate, so the full TLS path, the
> "backend port is not published" property, and the `pg_dump` → `pg_restore`
> cycle can all be proven locally (see [Local verification](#local-verification),
> the same steps the phase-5 gate uses). Only §2 (host hardening) and a
> **live-domain certificate** genuinely need the VPS.

---

## 1. Architecture

```
         internet
             │  https://sprout.yourdomain.com (443) / http (80)
             ▼
        ┌──────────┐
        │  Caddy   │  reverse proxy, automatic HTTPS, TLS termination
        │ :80/:443 │
        └────┬─────┘
             │  http://backend:3000 (sprout-net, private)
             ▼
        ┌──────────┐      ┌──────────────┐
        │ backend  │─────▶│   postgres   │
        │ :3000    │      │   (internal) │
        └──────────┘      └──────────────┘
```

- **Only Caddy publishes a port** (`80`/`443`). The backend does **not**
  publish `3000` — `docker-compose.prod.yml` resets its `ports` list
  (`ports: !reset []`), so it is reachable only from inside the `sprout-net`
  network.
- Postgres is also not exposed to the internet. On the VPS, close its host
  port too — see §2.

---

## 2. VPS setup (Hetzner CPX21 4 GB, Ubuntu 24.04) — **[manual]**

This section needs a real server; there is nothing to verify locally.

- **Create a non-root sudo user** and copy your SSH keys to it.
- **Disable root SSH login and password auth** (`PermitRootLogin no`,
  `PasswordAuthentication no`), restart ssh.
- **`unattended-upgrades` + `fail2ban`** enabled.
- **UFW:** deny incoming except `22/80/443`; allow outgoing. (Plus the Hetzner
  Cloud Firewall as belt-and-braces.)
- **`chmod 600 .env`**.
- **Close Postgres' host port.** The base `docker-compose.yml` maps
  `${POSTGRES_PORT:-5432}:5432` for local dev; on the VPS that is an extra
  attack surface for no benefit. Either add `ports: !reset []` to the
  `postgres` service in your prod overlay, or don't forward the port.
- App bound behind the reverse proxy (not exposed directly — see §3).

The 4 GB box matters: each Chromium is ~300 MB and `MAX_CONCURRENT_RUNS=3`,
plus Postgres (~150 MB) + Node + Caddy. **Keep `MAX_CONCURRENT_RUNS=3` (or 4).**
If you ever run on a 2 GB box, drop it to **2**.

---

## 3. First deploy

### 3.1 Clone and configure `.env`

```bash
git clone <repo> && cd sprout-automator
cp .env.example .env
chmod 600 .env
```

Fill in the secrets:

```bash
# APP_ENCRYPTION_KEY — 32 bytes as 64 hex chars
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# SESSION_SECRET — long random string
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

The full production environment table is in §4. Set at least:
`NODE_ENV=production`, `APP_URL`, `SIGNUP_ALLOWED`, and the two secrets. **The
app refuses to boot without `DATABASE_URL`-derived values, `APP_ENCRYPTION_KEY`,
and `SESSION_SECRET`** — and in production without `SIGNUP_ALLOWED` and a
non-localhost `APP_URL` (see §4).

### 3.2 Bring it up

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

First time (or when migrations change):

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backend pnpm db:migrate
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart backend
```

### 3.3 Verify

```bash
# domain mode — a real cert, no -k:
curl https://sprout.yourdomain.com/health
# IP/local mode (self-signed) — -k to accept the internal CA:
curl -k --noproxy '*' https://<host>/health
```

Expected: `{"status":"ok","service":"sprout-automator-backend",...,"db":"ok"}`.

---

## 4. Production environment

`config.ts` is the authority; this is the deploy-time summary. **Phase 5 adds a
boot-time guard** (already in the code): in production, an `APP_URL` whose host
is `localhost` or `127.0.0.1` refuses to start — the app will no longer boot
"happily" while every password-reset and email-verification link points at
localhost.

**Hard-required — the app refuses to boot without them:**
`DATABASE_URL`, `APP_ENCRYPTION_KEY` (64 hex chars), `SESSION_SECRET` (≥32 chars).

**Required in production specifically:**
- `NODE_ENV=production` — defaults to `development`, so the prod compose must set it explicitly rather than inherit from `.env`. Under `development` the session cookie is not `Secure`; under `production` it is, which is what you want behind Caddy.
- `SIGNUP_ALLOWED` — already refuses to boot when empty in production (4A.2). Set it to the team domain plus any exact addresses.

**⚠️ `APP_URL` is the silent one — fix this in the code, not just the runbook.** It defaults to `http://localhost:3000`. In production the app boots fine and everything appears to work, but **every password-reset and email-verification link points at localhost**, so a colleague clicking one gets nothing. Nothing warns, because a default exists.
**Requirement for this phase:** extend `config.ts` so that in production an `APP_URL` whose host is `localhost` or `127.0.0.1` **refuses to start**, with a message naming the fix — the same shape as the existing `SIGNUP_ALLOWED` production guard. An invisible failure becomes a startup error.

**Optional but worth setting:**
- `RESEND_API_KEY` + `MAIL_FROM` — without them, reset and verification emails only reach the server log. The app is usable without mail; password reset effectively is not. Note the free tier needs **one verified domain with SPF/DKIM DNS records**: the built-in `onboarding@resend.dev` sender only delivers to your own Resend account address, so it cannot reach colleagues.

> ⚠️ **As-built (found 2026-08-11):** the **base** `docker-compose.yml` does not pass most of the keys in this section through to the container — only `NODE_ENV`, `PORT`, `DATABASE_URL`, `APP_ENCRYPTION_KEY`, `SESSION_SECRET`, `DATA_DIR`, `SPROUT_URL` and `TZ`. Setting `APP_URL`, `AUTH_RATE_LIMIT`, `MAIL_FROM`, `MAX_CONCURRENT_RUNS`, `MISSED_RUN_GRACE_MINUTES`, `RESEND_API_KEY` or `SIGNUP_ALLOWED` in `.env` **silently has no effect under Docker**. See `BACKLOG.md` § 4; fix that before relying on any value below.
> ✅ **Fixed 2026-08-12 (phase 8 §8A).** The base compose now passes every config key through with `${KEY}` interpolation (plus `TRUST_PROXY_HOPS`, phase 8 §8C); an unset key arrives as an empty string, which `config.ts` treats as absent, exactly like a native run. The `docker-compose.prod.yml` overlay only re-declares what it genuinely overrides.
- `SPROUT_URL`, `MAX_CONCURRENT_RUNS` (drop to 2 on a 2 GB box), `MISSED_RUN_GRACE_MINUTES`, `AUTH_RATE_LIMIT` (raise if the team shares one NAT — `BACKLOG.md` § 3), `TZ=Asia/Manila`, `DATA_DIR`.

**Not a config item, already handled:** `pino-pretty` is a devDependency the image's `--prod` install omits, so the logger guards the pretty transport (commit `60b99d6`). Don't reintroduce an unguarded transport.

### Setting it in `.env`

```ini
NODE_ENV=production
APP_URL=https://sprout.yourdomain.com        # MUST NOT be localhost/127.0.0.1
SIGNUP_ALLOWED=yourdomain.com                # team domain + any exact addresses
TZ=Asia/Manila
MAX_CONCURRENT_RUNS=3
# RESEND_API_KEY=re_xxxxxxxxxxxx            # set BOTH or neither
# MAIL_FROM=Sprout Automator <no-reply@yourdomain.com>
# MISSED_RUN_GRACE_MINUTES=20
# AUTH_RATE_LIMIT=30
```

`docker-compose.prod.yml` passes these through to the backend container;
variables left unset are passed as empty strings, which `config.ts` treats
correctly (empty `SIGNUP_ALLOWED` in production = refuse to boot).

### 4.1 Rate limiting behind a Cloudflare Tunnel (opt-in) — **`[manual]` on a real tunnel**

The rate limiters key on `CF-Connecting-IP` **only when the request arrived
from a trusted Cloudflare peer**, so the header is ignored today (safe
default: a spoofable header can't split the budget — no evasion or poisoning).
Once a Cloudflare Tunnel is in front (`BACKLOG.md` § 12 — client → CF edge →
`cloudflared` → Express), the header is Cloudflare's and the limiter should use
it, or **every user on the tunnel shares one auth bucket** and the first
morning's password fumbling locks the whole team out.

**To enable it** (nothing else — the peer gate replaces `TRUST_PROXY_HOPS`-style
guessing):

```ini
TRUSTED_CLOUDFLARE_PEERS=<address the backend sees from cloudflared>
```

Find that address from inside the network, e.g.
`docker inspect <cloudflared-container> --format '{{.NetworkSettings.Networks.sprout-net.IPAddress}}'`
(or the host IP if the connector runs outside compose). **Do not** list Caddy's
address — Caddy forwards a client-supplied `CF-Connecting-IP` verbatim, so
trusting it re-opens the spoofing hole. Leaving the key empty is correct until
a tunnel exists: the limiter falls back to `req.ip`, which behind the
base-compose direct exposure is the real client already.

---

## 5. Caddyfile — the two modes

`Caddyfile` ships with both modes documented and the **IP/local mode active**,
so the file is testable before any domain exists. On the VPS you swap to domain
mode: a two-line edit, then `docker compose restart caddy`.

**MODE 1 — public domain (the real deploy).** Point a DNS `A` record at the
VPS, then in `Caddyfile` uncomment the domain block and comment out the
`localhost` block (lines 31–35):

```caddyfile
sprout.yourdomain.com {
	encode gzip
	reverse_proxy backend:3000
}
```

Caddy obtains and renews a real Let's Encrypt certificate automatically — no
`tls` directive needed. **Do not leave `tls internal` on a public domain** or
visitors get a self-signed cert.

**MODE 2 — IP / local (no domain).** The shipped default:

```caddyfile
localhost {
	tls internal
	encode gzip
	reverse_proxy backend:3000
}
```

`tls internal` issues a self-signed certificate from Caddy's internal CA. That
exercises the real TLS path (TLS termination, `Secure` cookies, HSTS) with no
DNS name — accept the cert with `curl -k` or a browser "not secure" bypass.

> **Why the site address is `localhost` and not `:443`:** Caddy's certificate
> automation only issues for named hostnames. A bare `:443 { tls internal }`
> block has no hostname, so no certificate exists and every TLS handshake dies
> with an "internal error" alert. On a LAN, replace `localhost` with the host's
> IP or LAN name — Caddy's internal CA issues for those too.

`docker-compose.prod.yml` publishes Caddy on `80`/`443`. If those host ports
are taken (e.g. local testing alongside another reverse proxy), override them:

```bash
CADDY_HTTP_PORT=8080 CADDY_HTTPS_PORT=8443 \
  docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

---

## 6. Backups — **[manual on a real host]**

Nightly `pg_dump` in custom format, gzipped, retained ~14 days, at 03:00
`TZ=Asia/Manila`. The restore path (`pg_restore --clean --if-exists`) is
**documented and tested** in §6.2 — an untested backup is not a backup.

### 6.1 Backup

`scripts/backup.sh` runs on the host and calls into the running `sprout-postgres`
container. Install it in the host crontab:

```bash
crontab -e
```

```cron
TZ=Asia/Manila
0 3 * * *  /path/to/sprout-automator/scripts/backup.sh >> "$HOME/backups/backup.log" 2>&1
```

Override with env vars: `BACKUP_DIR` (default `~/backups`), `RETENTION_DAYS`
(default 14), `POSTGRES_USER`, `POSTGRES_DB`, `SPROUT_POSTGRES_CONTAINER`.

> ⚑ **Recommended:** an **off-host encrypted** copy (rsync to a second host or
> S3, encrypted with `age`/`gpg`). A backup on the same disk as the thing it
> backs up is only protection against mistakes, not against a dead VPS.

### 6.2 Restore (tested path)

Restore goes into a **scratch** database, never the live one:

```bash
scripts/restore.sh ~/backups/sprout-<stamp>.dump.gz
```

This runs `pg_restore -U sprout -d <scratch> --clean --if-exists` over the
gzip-decompressed dump. Verify the tables are there, then drop the scratch DB:

```bash
docker exec sprout-postgres psql -U sprout -d sprout_restore_<epoch> -c '\dt'
docker exec sprout-postgres dropdb -U sprout sprout_restore_<epoch>
```

If the scratch DB was created with a different owner than the original dump
(not the case when both are `sprout` on the same host), add `--no-owner` to the
`pg_restore` line.

---

## 7. Day-2 operations

- **Logs:** `docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f backend` (greppable for `error`). ⚑ If you adopted `pino`, ship logs to a free tier (Axiom / Better Stack) for searchability.
- **Update:** `git pull` → `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build` → run `pnpm db:migrate` if migrations changed.
- **Free uptime check:** UptimeRobot against `https://<host>/health`.
- ⚑ **Recommended ops add-on:** a `data/` cleanup job that prunes
  `screenshots/<userId>/<runId>` older than N days keeps the volume from
  growing unbounded (see `BACKLOG.md`).

---

## 8. Onboarding a colleague

Share the URL privately, they sign up + follow the in-app Gmail walkthrough +
"Test Gmail connection", set a schedule, do one manual "Clock in now" to
confirm the full path against real HRHub. The DB partial unique index
guarantees one user's runs never collide with another's.

---

## Local verification

Everything except §2 (host hardening) and a live-domain cert is provable on one
machine — this is the phase-5 gate:

```bash
# Stop anything already on port 3000 (the dev-loop backend), then:
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backend pnpm db:migrate
curl -k --noproxy '*' https://localhost/health          # {"status":"ok",...,"db":"ok"}
curl --noproxy '*' http://127.0.0.1:3000/health          # must FAIL (port not published)
```

If `80`/`443` are already bound on the test machine, use the port overrides
from §5 (e.g. `CADDY_HTTPS_PORT=8443` and `https://localhost:8443/health`).
On Windows, native `curl` (schannel) may also need `--ssl-no-revoke` alongside
`-k` to accept the self-signed cert; WSL/OpenSSL `curl -k` works as-is.

**The `APP_URL` guard:** restart the backend with a bad value and confirm it
refuses to boot:

```bash
APP_URL=http://localhost:3000 \
  docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d backend
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs backend | grep APP_URL
```

You should see `Invalid environment configuration:` with the `APP_URL` issue;
the container exits. Restore the good value afterwards.

**Backups:** run `scripts/backup.sh`, then `scripts/restore.sh <dump>` and
confirm the scratch DB's tables, as in §6.
