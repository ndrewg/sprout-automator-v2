# Running Sprout Automator (self-host / leave-it-running)

This guide is for running the app on a machine (e.g. a laptop) and leaving it
up so the scheduler auto-clocks Mon–Fri. It uses the **Docker production build**
(the whole app in one container, the in-process wall-clock scheduler, bundled UI
served by Express). For day-to-day *development* use the dev loop instead (see
the end).

> Full HTTPS/reverse-proxy deployment (Caddy) is Phase 5 → `DEPLOY.md`. This
> guide covers a plain `http://localhost:3000` run on your own box;
> `DEPLOY.md` § *Windows laptop host* covers the scheduled Windows machine
> itself (phase 18).

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

**The two secrets in `.env`:**

| Var | What it is | Rotating it means… |
|-----|-----------|--------------------|
| `APP_ENCRYPTION_KEY` | 32-byte (64 hex) key that AES-256-GCM-encrypts stored Sprout/Gmail credentials | Existing stored credentials can no longer be decrypted — you must re-enter them |
| `SESSION_SECRET` | signs the `sid` session cookie | Everyone is logged out (must sign in again) — harmless |

- **Never commit these.** `.env` is gitignored on purpose; the pre-commit
  gitleaks hook will also block an accidental secret commit. They exist only in
  the local `.env` file (and injected into the container by Docker Compose).
- **Moving to the laptop:** since `.env` doesn't travel with `git`, either
  (a) **generate fresh secrets on the laptop** (simplest — you'll re-enter your
  Sprout/Gmail creds in the UI because the DB is fresh too), or
  (b) **copy your existing `.env` file directly** to the laptop over a secure
  channel (USB, `scp`, password manager) if you also migrate the Postgres data
  and want your saved credentials to keep working — the `APP_ENCRYPTION_KEY` must
  match the data. Don't paste the values into chat, tickets, or committed files.

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

### For it to fire

The scheduler is **in-process and timezone-aware** (`Asia/Manila`, Mon–Fri). It
is no longer `node-cron`: a single shared **wall-clock tick** (every 15 s)
compares the real time against what is due and fires the slots, retries and the
missed-run sweep. Nothing waits on a long timer, so a slow
container clock can only delay a job by up to one tick. (The old node-cron
design armed one long `setTimeout` per slot; the Docker VM's clock drifted
minutes a day and dropped a clock-in ~once a week — see
`rebuild/02-DECISIONS-AND-ARCHITECTURE.md` **D8**.)

- **Only the scheduled machine clocks anyone.** Scheduling is opt-in per
  process: `SCHEDULER_ENABLED=true` in the **laptop's** `.env`. It defaults to
  **`false`**, and while it is false this process registers no daily slots, no
  retries, no missed-run sweep — manual runs and the whole
  UI still work, which is exactly what makes a missing line look like nothing at
  all. Leave it unset on every other machine (the work PC included):
  `GET /health` reports `scheduler.enabled`, so you can always tell which host is
  which.
- **Stop the laptop from sleeping/hibernating.** The tick only runs while the
  process is alive and does **not** back-fill a slot it slept through — asleep
  at 05:30 means that clock-in did not happen (you can still "Clock in now" by
  hand). Set power to *never sleep* while plugged in, *"do nothing"* on lid
  close, and **keep it plugged in** on a stable network. Phase 18 § 18A has the
  exact Windows settings.
- **Start Docker Desktop on login** (Settings → General → **"Start Docker Desktop
  when you sign in to your computer"**). Containers auto-restart, but only if
  Docker itself is running — and Docker Desktop **cannot** start before an
  interactive login, so a Windows Update reboot that leaves the machine at the
  login screen takes the stack down with it. That is the case the outside
  monitor below exists to catch; phase 18 § 18A sets Windows Update *active
  hours* around the clock-in windows.
- **A failed run retries, a missing one alerts.** The **already-clocked guard**
  means a duplicate run for the same action/day ends as `skipped` — safe. A run
  that *fails* is retried on its own, bounded by `RETRY_MAX_ATTEMPTS` and the
  per-action wall-clock cutoffs. A slot that never ran at all raises a
  **missed-run** alert. Neither is a substitute for the host being awake.

### Pausing: use the calendar, not the power switch

Powering the laptop off is indistinguishable from the laptop being broken — the
outside monitor below cannot tell the difference and will page you. To take time
off:

- **Skip individual days** in the **Schedule** panel's calendar (phase 16): mark
  a day *Skip*, and today's pending retry is cancelled with it.
- **Or set a pause range** (`paused_from` / `paused_until`) for leave. It
  **expires on its own** — a date range, never a boolean, so a forgotten pause
  cannot silently stop you clocking in for a month (D18).
- Every deliberate skip (a skip day, a pause window, a holiday the app skips)
  sends one notice per would-be clock day — deliberate, not noise. The
  **skipped** toggle in the Notifications panel is the mute.

### Something outside the laptop watches it

Nothing inside the stack can report that the stack is down, so the alarm has to
live outside it. The app pings an **outside dead-man's switch** when a scheduled
slot reaches an *outcome* (success, a deliberate skip, or a give-up — not while a
retry is still queued). Point `HEARTBEAT_URL` in the laptop's `.env` at your
monitor's ping URL — healthchecks.io by default, see `DEPLOY.md` § *Windows
laptop host* and phase 18 § 18B.

- **Configure the check as a *Cron* schedule**, not an interval — cron
  expression `15 5,16 * * 1-5`, *Server's Time Zone* `Asia/Manila`, *Grace Time*
  45 minutes (healthchecks.io's field names; every equivalent monitor takes the
  same three). This host is deliberately off over the weekend, so an interval
  check calls every weekend an outage, and an alarm that cries wolf is one you
  mute.
- **`/health` reports `heartbeat.configured`** (a boolean — the ping URL itself
  is never exposed, on any endpoint). Set `HEARTBEAT_URL` and restart the backend
  outside 05:15–05:45 and 16:00–16:30, then confirm it flips to `true`.

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

**Testing password reset locally:** with no mail provider, the reset email is
logged to the backend console, and the link in it points at `APP_URL`. The
default is `http://localhost:3000` — right for the Docker build, but in this
dev loop that port serves whatever stale bundle is in `app/backend/public`. Set
`APP_URL=http://localhost:5173` in `.env` (and restart the backend) so reset
links land on the Vite SPA. You can also test the *logged-out* flow on :5173
directly at `/reset?token=…`.
