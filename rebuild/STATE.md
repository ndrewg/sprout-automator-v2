# STATE — where this build actually is

Read this first, before any phase file. The phase docs describe a *plan*; this describes the *reality*. When they disagree, this file wins and the phase file needs a correction note.

Last updated: **2026-08-07**. Phases T, 6, 7 and 4A.2 all built, reviewed and committed in one session (`ccc6f30`, `a81c96d`, `e6c81f9`, + signup gating). Every `[manual]` check for 6 and 7 passed against live Telegram and live HRHub, except the phase-6 success ✅ notification, which is deferred because it cannot be produced without a real clock action. Phase 6 is tagged; T and 7 are not.

---

## Built and verified

| Area | State | Evidence |
|---|---|---|
| Scaffold, config validation, health, pino logging | ✅ | tag `phase-0-complete` |
| Postgres 18 + Drizzle schema + migrations | ✅ | tag `phase-1-complete` |
| Argon2id auth, DB-backed signed-cookie sessions, audit log | ✅ | tag `phase-1-complete` |
| AES-256-GCM credentials, partial-update contract | ✅ | tag `phase-1-complete` |
| Playwright automation (login, OTP, clock, screenshots) | ✅ validated against **live HRHub** | tag `phase-2-complete` |
| Run queue, partial-unique-index race guard, orphan recovery | ✅ | tag `phase-2-complete` |
| IMAP OTP polling racing the manual paste bridge | ✅ | tag `phase-2-complete` |
| node-cron scheduler, Manila, Mon–Fri, PH holiday skip | ✅ | tag `phase-2-complete` |
| React 19 / Tailwind 4 / shadcn SPA, four panels, responsive | ✅ | tag `phase-3-complete` |
| SPA served from Express in the production image | ✅ | tag `phase-3-complete` |
| Helmet CSP + HSTS, rate limits, trust proxy, body cap | ✅ | commit `21a0971` — **4A only, not tagged** |
| Test harness: `app.ts`/`index.ts` split, vitest unit+integration projects, 23 integration tests, Playwright e2e | ✅ | phase T — `[manual]` Docker check passed; not yet tagged |
| Run notifications + missed-run reconciliation | ✅ | commit `a81c96d`; six review rounds (defects 3, 12, 17, 18, 19, 20). `[manual]`: settings round-trip, test button, rate limit, enable guard, encrypted-at-rest, failure ⚠️, skipped ℹ️, missed 🔴 (incl. no-duplicate) all verified live — see `reviews/phase-6-addendum.md` § E. Success ✅ deferred (needs a real clock action). **Not yet tagged** |
| Signup gating — email allowlist (§ 4A.2) | ✅ | `SIGNUP_ALLOWED` takes domains and exact addresses; optional in dev (allow-all + warning), **required in production or the app refuses to boot**. All six `[manual]` checks passed live, including the substring attack (`notorchard.com.au` → 403) and grandfathering (an address removed from the list could no longer sign up but still logged in). Rejections audit an `emailHash` only. See `reviews/phase-4A2-addendum.md`. **Not yet tagged** |
| Pause / leave days (schedule pause window + controls) | ✅ | commit `e6c81f9`; gates 7A + 7B green (66 unit, 48 integration, e2e desktop + mobile). **All seven `[manual]` checks passed live** — banner, "Skip tomorrow", **a paused day suppressed a real cron fire**, **no missed-run alert while paused and the alert returned once unpaused**, manual runs still work while paused, clearing restores normal, and a past window auto-expired with no user action. Migration `0002_pause.sql` applied to the dev DB and `pnpm dev` verified booting. See `reviews/phase-7-addendum.md`. **Not yet tagged** |

The app runs today via `docker compose up -d --build` on `http://localhost:3000` (see `RUNNING.md`). Backend tests live in `app/backend/test/` mirroring `src/`.

## Not built

| Area | Where it's specified | Blocking? |
|---|---|---|
| Account lifecycle: email verify, password reset, idle timeout, deletion, export | `phases/phase-4-security.md` § 4B | before inviting >3 people |
| TLS deploy: `docker-compose.prod.yml`, `Caddyfile`, `DEPLOY.md`, backups | `phases/phase-5-deploy-ops.md` | before leaving the LAN |
| Everything else | `BACKLOG.md` | ranked there |

## Suggested order from here

The goal is **all the code finished and verified locally in Docker**, with no VPS yet. That is achievable for everything except the parts that need a real host.

1. **Phase 4B** — account lifecycle. Email flows work in dev without a provider: `lib/mailer.ts` logs the email instead of sending when `RESEND_API_KEY` is unset. Wants the test harness underneath it (now built), since it rewrites auth.
2. **Phase 5 artifacts** — `docker-compose.prod.yml`, `Caddyfile`, `DEPLOY.md`, the backup script. **Write and verify these locally**: Caddy's `tls internal` issues a self-signed cert, so the full TLS path, the "backend port not published" property, and the `pg_dump`/restore cycle can all be proven on your own machine. What genuinely needs the VPS is only §5.2 (host hardening) and the live-TLS gate item — mark those `[manual]` and leave them.

Working prompts for each round are in [`SESSION-PROMPT.md`](./SESSION-PROMPT.md).

## Known gaps in what *is* built

- **Phases 0–5 gates are prose, not commands.** They were verified by hand at the time and are not re-runnable. `reference/testing-strategy.md` § "The high-value tests" lists what to backfill; the race guard and tenant isolation now have tests (phase T).
- **Frontend logout once dropped the user's session without unmounting the Dashboard** — `qc.clear()` empties the cache but does not notify the `["me"]` observer in AuthGate, so it kept its stale user. Fixed in phase T by switching `useLogout` to `qc.resetQueries()` (notifies subscribers + refetches); caught by the e2e smoke flow.
- **The e2e webServer builds the SPA into `app/backend/public` and migrates `sprout_test`** before booting the backend — so `pnpm test:e2e` needs Postgres running (`docker compose up -d postgres`) and writes into the same `sprout_test` database the integration suite uses.
- **E2E depends on a Chromium the frontend never installed.** `@playwright/test` is a frontend devDependency (pinned `1.60.0`, matching the backend's `playwright` pin — bump both together), but it is **not** in the frontend's `pnpm-workspace.yaml` `allowBuilds`, so pnpm blocks its browser-download postinstall. It works today only because the backend's `playwright install chromium` populated the shared `~/.cache/ms-playwright`. On a fresh machine that installs the frontend without the backend — or in CI, if e2e is ever added there — `pnpm test:e2e` fails with "browser not installed". Fix when it bites: add `'@playwright/test': true` to the frontend `allowBuilds`, or run `pnpm exec playwright install chromium` as a documented setup step.
- **`_archive/` holds a live `.env` and session cookies.** Gitignored, reference-only, forbidden by the guardrails. Should be deleted — `BACKLOG.md` § 8.

## Conventions that changed after the phase docs were written

- **Audience.** Phases 0–5 were written for a quantized local model driven one phase per session. The build now targets a hosted agentic model (see `00-START-HERE.md` § "Model & runtime"). Phases 0–5 are kept **as an as-built record** — don't rewrite them; they document what was done and why.
- **Gates.** New phases state gates as commands with exit codes, marking human-only checks `[manual]`. See `reference/testing-strategy.md`.
- **Tests** live in `test/` mirroring `src/`, not colocated (commit `8c3d226`).
- **Test layout (phase T):** `test/lib/**`, `test/services/**` are the database-free `unit` vitest project (`pnpm test`); `test/integration/**` is the `integration` project against `sprout_test` (`pnpm test:integration`, single fork so the shared DB is never truncated concurrently). E2E lives in `app/frontend/e2e/` (`pnpm test:e2e`), driven by a `webServer` that builds the SPA into `app/backend/public`, migrates `sprout_test`, and boots the real backend.
