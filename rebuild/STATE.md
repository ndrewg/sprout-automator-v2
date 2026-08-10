# STATE — where this build actually is

Read this first, before any phase file. The phase docs describe a *plan*; this describes the *reality*. When they disagree, this file wins and the phase file needs a correction note.

Last updated: **2026-08-10**. **Every phase is complete** — 0–3 from the original build, plus T, 4A.2, 4B, L, 5, 6 and 7. Remaining work is `BACKLOG.md` and two `[manual]` items that need a real VPS. 4B was split across two rounds: mailer + password reset + idle timeout (round 1), then email verification + account deletion (round 2). **4B.6 (data export) and 4B.7 (monitoring hooks) were deliberately skipped** — export is ceremony for a handful of users, and admin visibility is ranked in `BACKLOG.md` instead — so 4B is functionally complete. Every `[manual]` check passed. **Tagged:** 0, 1, 2, 3, T, 4A2, 6, 7. **Untagged:** 4 (all of 4B), L, 5 — the human tags, since only they can confirm the `[manual]` checks.

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
| Email verification + account deletion | ✅ | **4B.2/4B.5** — round 2. Verify tokens reuse `reset_tokens` with `purpose`, 24 h TTL, single-use. **A privilege escalation was found and fixed here unprompted:** `consumeResetToken` ignored `purpose`, so a 24 h verify token could be spent at the 1 h reset endpoint to change a password; purpose is now required and tested both directions. Deletion re-confirms the password, refuses while a run is active, unregisters cron, writes a surviving `account_deleted` audit row (`user_id` NULL + `emailHash`), cascades eight tables and removes the user's data directories. **Verification is deliberately NOT enforced** — with no mail provider the links only reach the server log, so gating actions on it would make the app unusable. All nine `[manual]` checks passed. **Not yet tagged** |
| Transactional email mailer + password reset + idle session timeout | ✅ | **4B.1/4B.3/4B.4** — environment-dependent dev/prod logging, single-use tokens, resettable rate-limit store for tests, 11th-is-429 property asserted at default. All nine `[manual]` checks passed. **Not yet tagged** |
| Test harness: `app.ts`/`index.ts` split, vitest unit+integration projects, 23 integration tests, Playwright e2e | ✅ | phase T — `[manual]` Docker check passed; not yet tagged |
| Run notifications + missed-run reconciliation | ✅ | commit `a81c96d`; six review rounds (defects 3, 12, 17, 18, 19, 20). `[manual]`: settings round-trip, test button, rate limit, enable guard, encrypted-at-rest, failure ⚠️, skipped ℹ️, missed 🔴 (incl. no-duplicate) all verified live — see `reviews/phase-6-addendum.md` § E. Success ✅ deferred (needs a real clock action). **Not yet tagged** |
| Run executor failure hardening (backlog #2 + #4) | ✅ | Executor rejection now marked `failure` with notification via `.catch` backstop; decrypt moved inside try/catch so corrupt `*_enc` triggers graceful failure not unhandled rejection; missed-run `notified_at` added for retry after Telegram outage; global unhandledRejection/uncaughtException handlers log as final backstop. New integration tests prove both paths. Setup scripts (`setup.ps1`/`setup.sh`) for first-run infrastructure + secret generation — **happy path unverified** (manual setup only; see scripts/setup.{ps1,sh} line 151-152). **Not yet tagged** |
| Signup gating — email allowlist (§ 4A.2) | ✅ | `SIGNUP_ALLOWED` takes domains and exact addresses; optional in dev (allow-all + warning), **required in production or the app refuses to boot**. All six `[manual]` checks passed live, including the substring attack (`notorchard.com.au` → 403) and grandfathering (an address removed from the list could no longer sign up but still logged in). Rejections audit an `emailHash` only. See `reviews/phase-4A2-addendum.md`. **Not yet tagged** |
| Linting wired up and proven (phase L) | ✅ | oxlint on **both** packages with the `correctness` category, plus `react/jsx-key` (`checkFragmentShorthand`), `react/exhaustive-deps`, and backend `no-floating-promises` / `no-misused-promises` / `prefer-await-to-then` (needs `oxlint-tsgolint` + `typeAware`). `pnpm lint` now runs in **CI and pre-commit**. Zero warnings baseline. **All four fault probes proven to fail the build**, including the fragment-shorthand missing key that triggered the round. The three sanctioned `.catch()` idioms carry narrow inline disables pointing at the rule. **Not tagged** |
| Pause / leave days (schedule pause window + controls) | ✅ | commit `e6c81f9`; gates 7A + 7B green (66 unit, 48 integration, e2e desktop + mobile). **All seven `[manual]` checks passed live** — banner, "Skip tomorrow", **a paused day suppressed a real cron fire**, **no missed-run alert while paused and the alert returned once unpaused**, manual runs still work while paused, clearing restores normal, and a past window auto-expired with no user action. Migration `0002_pause.sql` applied to the dev DB and `pnpm dev` verified booting. See `reviews/phase-7-addendum.md`. **Not yet tagged** |
| TLS deploy: `docker-compose.prod.yml`, `Caddyfile`, `DEPLOY.md`, `APP_URL` production guard, backups | ✅ | `docker-compose.prod.yml` + `Caddyfile` (both modes, localhost + domain); Caddy reverse proxy on 80/443, backend port reset; `DEPLOY.md` complete runbook; APP_URL production guard in `config.ts` with tests; `pg_dump --clean --if-exists` restore tested to scratch DB. VPS host hardening (§5.2) and live-domain TLS remain `[manual]`. Gate: `pnpm typecheck && pnpm test && pnpm test:integration && pnpm build` all green. Spec corrections: bare `:443 { tls internal }` doesn't work (no hostname for certs), use `localhost` instead; `docker exec -T` removed in Docker 29.5, use `-i` for stdin; Caddy ports parameterized (§5, overridable via env). See `reviews/phase-5-deploy-ops-addendum.md`. **Not yet tagged** |

The app runs today via `docker compose up -d --build` on `http://localhost:3000` (see `RUNNING.md`). Backend tests live in `app/backend/test/` mirroring `src/`.

## Not built

| Area | Where it's specified | Blocking? |
|---|---|---|
| Everything else | `BACKLOG.md` | ranked there |

## Suggested order from here

All phases are done. What is left:

1. **`BACKLOG.md`** — ten ranked items, none load-bearing. #3 (screenshot pruning) and #4 (rate limiter, decision made: raise `AUTH_RATE_LIMIT` to 30) are the next sensible ones; #5 (onboarding + the Gmail-only constraint) matters before inviting anyone.
2. **The two `[manual]` deploy items** — VPS host hardening (`phase-5-deploy-ops.md` § 5.2) and live-domain TLS. Both need a real host; everything else about the deploy is proven locally.

Working prompts for each round are in [`SESSION-PROMPT.md`](./SESSION-PROMPT.md).

## Known gaps in what *is* built

- **Phases 0–5 gates are prose, not commands.** They were verified by hand at the time and are not re-runnable. `reference/testing-strategy.md` § "The high-value tests" lists what to backfill; the race guard and tenant isolation now have tests (phase T).
- **Frontend logout once dropped the user's session without unmounting the Dashboard** — `qc.clear()` empties the cache but does not notify the `["me"]` observer in AuthGate, so it kept its stale user. Fixed in phase T by switching `useLogout` to `qc.resetQueries()` (notifies subscribers + refetches); caught by the e2e smoke flow.
- **The e2e webServer builds the SPA into `app/backend/public` and migrates `sprout_test`** before booting the backend — so `pnpm test:e2e` needs Postgres running (`docker compose up -d postgres`) and writes into the same `sprout_test` database the integration suite uses.
- **E2E depends on a Chromium the frontend never installed.** `@playwright/test` is a frontend devDependency (pinned `1.60.0`, matching the backend's `playwright` pin — bump both together), but it is **not** in the frontend's `pnpm-workspace.yaml` `allowBuilds`, so pnpm blocks its browser-download postinstall. It works today only because the backend's `playwright install chromium` populated the shared `~/.cache/ms-playwright`. On a fresh machine that installs the frontend without the backend — or in CI, if e2e is ever added there — `pnpm test:e2e` fails with "browser not installed". Fix when it bites: add `'@playwright/test': true` to the frontend `allowBuilds`, or run `pnpm exec playwright install chromium` as a documented setup step.
- **IDE type errors may be spurious.** `tsc -b` on the frontend is clean; editors showing `Property 'error' does not exist` on the discriminated unions in `CredentialsPanel`/`NotificationsPanel` are using their bundled TypeScript rather than the workspace's TS 6. Select the workspace version, or restart the TS server.
- **`_archive/` holds a live `.env` and session cookies.** Gitignored, reference-only, forbidden by the guardrails. Should be deleted — `BACKLOG.md` § 8.

## Conventions that changed after the phase docs were written

- **Audience.** Phases 0–5 were written for a quantized local model driven one phase per session. The build now targets a hosted agentic model (see `00-START-HERE.md` § "Model & runtime"). Phases 0–5 are kept **as an as-built record** — don't rewrite them; they document what was done and why.
- **Gates.** New phases state gates as commands with exit codes, marking human-only checks `[manual]`. See `reference/testing-strategy.md`.
- **Tests** live in `test/` mirroring `src/`, not colocated (commit `8c3d226`).
- **Test layout (phase T):** `test/lib/**`, `test/services/**` are the database-free `unit` vitest project (`pnpm test`); `test/integration/**` is the `integration` project against `sprout_test` (`pnpm test:integration`, single fork so the shared DB is never truncated concurrently). E2E lives in `app/frontend/e2e/` (`pnpm test:e2e`), driven by a `webServer` that builds the SPA into `app/backend/public`, migrates `sprout_test`, and boots the real backend.
