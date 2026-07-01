# Running Sprout Automator (self-host / leave-it-running)

This guide is for running the app on a machine (e.g. a laptop) and leaving it
up so the scheduler auto-clocks Mon–Fri. It uses the **Docker production build**
(the whole app in one container, in-process cron scheduler, bundled UI served by
Express). For day-to-day *development* use the dev loop instead (see the end).

> Full HTTPS/reverse-proxy deployment (Caddy) is Phase 5 → `DEPLOY.md` (not yet
> written). This guide covers a plain `http://localhost:3000` run on your own box.

---

## Prerequisites

- **Docker Desktop** installed and running. That's it — the image builds the
  frontend, installs the backend, and bundles Chromium (Playwright base image).
  You do **not** need Node/pnpm/Chromium on the host for the Docker path.
- The project folder (via `git clone` or copied). Note: **`.env` is gitignored**,
  so it will NOT come across with `git` — you recreate it (next step).

---

## First-time setup

### 1. Create `.env` at the repo root

```bash
cp .env.example .env
```

Then fill in two secrets:

```bash
# APP_ENCRYPTION_KEY — 32 bytes as 64 hex chars
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# SESSION_SECRET — long random string
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

(If you don't have Node on the laptop, generate these on any machine — they're
just random strings.)

> ⚠️ **APP_ENCRYPTION_KEY rule.** Stored Sprout/Gmail credentials are encrypted
> with this key.
> - **Fresh start on the laptop (recommended):** generate a NEW key. The database
>   starts empty, so you'll re-enter your credentials in the UI (below). Fine.
> - **Reusing an existing database** (you copied the Postgres volume): you MUST
>   use the SAME `APP_ENCRYPTION_KEY` as the machine that saved the creds, or they
>   won't decrypt.

> ⚠️ **Leave `NODE_ENV=development`** for a plain `http://localhost:3000` run.
> Under `production` the session cookie is `Secure`-only and won't be sent over
> plain HTTP — login silently fails. Use `production` only behind HTTPS (Phase 5).

### 2. Build and start

```bash
docker compose up -d --build
```

This starts Postgres + the backend (which serves the UI). `restart: unless-stopped`
brings them back after a Docker or machine restart.

### 3. Apply database migrations (first time / after schema changes)

On an empty database the backend can't start until the tables exist, so run:

```bash
docker compose run --rm backend pnpm db:migrate
docker compose restart backend
```

Confirm it's healthy:

```bash
curl http://localhost:3000/health    # expect {"status":"ok",...,"db":"ok"}
```
(On a corporate/proxied network use `curl --noproxy '*' http://127.0.0.1:3000/health`.)

### 4. Configure it in the browser — http://localhost:3000

1. **Sign up** (or log in).
2. **Sprout HRHub card** → enter username + password → **Save**.
3. **Gmail card** → enter your Gmail address + a **Gmail App Password**
   (see the in-app "How do I set this up?" walkthrough) → **Save** →
   **Test Gmail connection** (expect "Connected — N messages").
4. **Schedule card** → set your clock-in / clock-out times → tick
   **Run automatically Mon–Fri** → **Save**. (Schedule is opt-in — it does
   nothing until you enable it.)

You can trigger a one-off run any time with **Clock in / Clock out now** and watch
progress in **Run history**.

---

## Leaving it running all week — read this

The scheduler is an in-process cron (`node-cron`, timezone **Asia/Manila**, Mon–Fri).
For it to fire, the process must be awake at the scheduled time:

- **Stop the laptop from sleeping/hibernating.** `node-cron` only runs while the
  process is alive and does **not** back-fill missed runs. If the laptop is asleep
  at 5:30am, that clock-in is missed (you can still "Clock in now" manually).
  Set power to *never sleep* while plugged in, and *"do nothing" on lid close*.
- **Keep it plugged in** and on a stable network.
- **Start Docker Desktop on login** (Docker Desktop → Settings → General →
  "Start Docker Desktop when you sign in"). Containers auto-restart, but only if
  Docker itself is running.
- The **already-clocked guard** means a duplicate run for the same action/day
  ends as `skipped` — safe. But there's no auto-catch-up for a missed slot.

### Checking on it
```bash
docker compose logs -f backend     # live logs incl. run steps (enqueued/started/finished)
docker compose ps                  # container status
```
Or just open the dashboard — **Run history** shows every run with its steps.

---

## Everyday commands

| Task | Command |
|------|---------|
| Start (build if changed) | `docker compose up -d --build` |
| Stop | `docker compose down` (keeps data) |
| Restart backend only | `docker compose restart backend` |
| Live logs | `docker compose logs -f backend` |
| Apply new migrations | `docker compose run --rm backend pnpm db:migrate && docker compose restart backend` |
| Wipe EVERYTHING incl. data | `docker compose down -v` (⚠️ deletes the DB volume) |

---

## Local development (not for leaving running)

Fast HMR loop — Postgres in Docker, backend + frontend native:

```bash
docker compose up -d postgres
cd app/backend  && pnpm dev      # native, tsx watch (~1s reload) on :3000
cd app/frontend && pnpm dev      # Vite HMR on :5173  ← open THIS in dev
```
Open **http://localhost:5173** (Vite proxies the API to :3000). Requires Node 22+
and `corepack enable pnpm` on the host. This is for editing code, not for
unattended runs.
