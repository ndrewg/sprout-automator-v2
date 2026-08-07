# Sprout Automator

A self-hosted, multi-tenant web app that automatically clocks you in and out of
**Sprout HRHub** on a daily schedule. Each user stores their own HRHub + Gmail
credentials (encrypted at rest), sets clock-in/out times, and the service drives
a headless browser to do the clocking — fetching the login OTP straight from
Gmail over IMAP, and skipping weekends and Philippine public holidays.

> Personal/internal tool. Runs on your own machine — see **[RUNNING.md](./RUNNING.md)**.

---

## What it does

- **Per-user credentials**, encrypted with AES-256-GCM (only the owner can use them).
- **Scheduled auto clock-in/out** — in-process `node-cron`, Mon–Fri, `Asia/Manila`,
  with a fail-safe "already clocked today → skip" guard (never double-clocks).
- **Automated login incl. OTP** — Playwright drives HRHub; the one-time code is
  read from the user's Gmail via IMAP (with a manual paste-in fallback in the UI).
- **PH public-holiday skip** via `date-holidays`.
- **Dashboard** to manage credentials/schedule, trigger one-off runs, and watch
  run history live.

## Tech stack

- **Backend:** TypeScript (ESM, run via `tsx` — no build step), Express 5,
  PostgreSQL 18 + Drizzle ORM, Playwright 1.60, `node-cron`, `imapflow`, pino.
- **Frontend:** React 19, Tailwind CSS v4, shadcn/ui, Vite, TanStack Query v5.
- **Runtime:** Docker Compose (Postgres + a single app container that serves the
  bundled SPA from Express). pnpm 11, Node 22+.

## Repository layout

```
app/
  backend/    Express API + automation engine + scheduler (src/, drizzle/ migrations)
  frontend/   React SPA (built and served by the backend in production)
rebuild/      The full build specification / phase-by-phase plan and references
docker-compose.yml   Postgres + backend
RUNNING.md    How to run it (Docker) / leave it running / dev loop
```

## Running it

See **[RUNNING.md](./RUNNING.md)** for the full guide. TL;DR (Docker):

```bash
cp .env.example .env        # then fill APP_ENCRYPTION_KEY + SESSION_SECRET
docker compose up -d --build
docker compose run --rm backend pnpm db:migrate   # first time
# open http://localhost:3000
```

For local development (hot reload): Postgres in Docker, backend + frontend native —
see the "Local development" section of RUNNING.md (open `http://localhost:5173`).

## Security

- Passwords hashed with **Argon2id**; sessions are **DB-backed signed cookies**
  (`SameSite=Strict`, HttpOnly), not JWTs.
- Credentials encrypted with **AES-256-GCM** (key from env; only `lib/encryption.ts`
  touches the encrypted columns). `GET /credentials` returns passwords only as
  `*Set` booleans — never plaintext.
- **Tenant isolation:** every query is scoped to the authenticated user id.
- **HTTP edge:** Helmet strict CSP + HSTS, rate limiting (auth 10/15min, API
  120/min), 100kb body cap.
- **Secret hygiene:** structured logging with a redaction list; `.env` gitignored;
  gitleaks pre-commit hook.

## Status

| Area | State |
|------|-------|
| DB, auth, encrypted credentials | ✅ done |
| Automation (Playwright, run queue, IMAP OTP, cron + holidays) | ✅ done, validated against live HRHub |
| Dashboard (SPA) | ✅ done |
| HTTP hardening (Helmet/CSP, rate limits) | ✅ done (Phase 4A) |
| Telegram run notifications + missed-run alerts | ⏳ next (Phase 6) |
| Pause / leave days | ⏳ planned (Phase 7) |
| Signup gating (invite code / allowlist) | ⏳ required before public hosting (Phase 4A.2) |
| Account lifecycle (email verify, password reset, etc.) | ⏳ deferred (Phase 4B — needs a mail provider) |
| HTTPS reverse-proxy deploy (Caddy) + `DEPLOY.md` | ⏳ pending (Phase 5) |

## Documentation

- **[RUNNING.md](./RUNNING.md)** — run / self-host / dev loop.
- **[rebuild/STATE.md](./rebuild/STATE.md)** — what's built, what's next, known gaps. Read this first.
- **[rebuild/BACKLOG.md](./rebuild/BACKLOG.md)** — ranked known-missing work.
- **[rebuild/00-START-HERE.md](./rebuild/00-START-HERE.md)** — the build spec, architecture decisions, and per-phase plan.
- **[AGENTS.md](./AGENTS.md)** / **[CLAUDE.md](./CLAUDE.md)** — always-on rules for AI-assisted work on this repo.
