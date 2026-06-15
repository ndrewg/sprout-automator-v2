# 02 — Decisions & Architecture

This is the distilled decision log. Every entry is **locked** — the LLM must not relitigate it. Each says *what* and *why* so that when the model is tempted to do the obvious-but-wrong thing, the reasoning is right here to point at.

At the end: **architecture diagrams**, **the data model summary**, and **my recommended improvements** over the as-built version (clearly marked — take them or leave them).

---

## June 2026 stack revisions (read first — these override the version numbers in the original decisions below)

A review before the fresh build updated several version/tech choices. The *architecture* is unchanged; these are version bumps + two new cross-cutting decisions:

- **Express 5** (was 4). Express 5 awaits async route handlers and forwards rejected promises to the error middleware — closing a latent bug where an `async` `throw` on Express 4 + Node would escape the global error handler (and could crash the process). See **D13**.
- **PostgreSQL 18** (was 16) — latest security patches; drop-in image-tag change.
- **Playwright 1.60.0** (was 1.49.1), npm package and Docker base image tag (`v1.60.0-noble`) bumped together.
- **Node 22** for the frontend build stage (was 20).
- **pnpm 11** as the package manager (was npm), for supply-chain hardening — script-blocking (`allowBuilds`) + release cooldown (`minimumReleaseAge`). See **D14** and `reference/supply-chain-and-ci.md`.
- **gitleaks pre-commit + minimal CI** (typecheck/test/audit) from commit 1 — adopted, not deferred (see improvements list at the end; the tsx-no-compile choice makes the typecheck gate essential).
- **Frontend stays React 18 / Tailwind 3** deliberately — matched to the current local model's late-2024 training cutoff. The migration to React 19 / Tailwind 4 is fully specced in `UPGRADE-PATH-react19-tailwind4.md` for when a newer-cutoff model is in use. See **D15**.
- **Deploy target is now Hetzner CPX21 (4 GB)** not CPX11 (2 GB) — headroom for 3 concurrent Chromiums. See **D12**.

Everything else below stands. Where a decision names an old version, the value above wins.

## Locked decisions

### D1 — TypeScript, ESM, `tsx`-run, Bundler resolution (NO `.js` extensions)
- TypeScript only. No `.js` files in the backend. `"type": "module"` (ESM).
- `tsconfig.json`: `target ES2022`, `module ESNext`, **`moduleResolution: "Bundler"`**, `noEmit: true`, `allowImportingTsExtensions: true`, plus strict + `noUncheckedIndexedAccess` + `noImplicitOverride` + `noPropertyAccessFromIndexSignature`.
- **The backend is never compiled.** It is run directly with `tsx` in *both* dev (`tsx watch`) and production (`pnpm exec tsx src/index.ts` in the container). There is no `dist/`.
- **Because resolution is Bundler, relative imports have NO extension:** `import { db } from "../db/client"` — *not* `"../db/client.js"`.
> ⚠️ **This supersedes the original ADR 0001**, which specified NodeNext + `.js` extensions. The project moved to Bundler + tsx. Build to the current reality described here. If you see `.js` extensions anywhere, that's stale.

### D2 — PostgreSQL 16 + Drizzle ORM (not Prisma, not SQLite)
- Postgres from day one. Not SQLite-first. Reason: concurrent writes at the 5:30 AM cron stampede, `timestamptz` correctness, `pg_dump`/PITR ergonomics. ~100 MB RAM is negligible on a 2 GB VPS.
- Drizzle (`drizzle-orm` + `drizzle-kit`), driver `pg` (node-postgres), pool size 10. Schema in `src/db/schema.ts`; migrations generated to `app/backend/drizzle/`.
- Drizzle over Prisma: readable SQL migrations you review in PRs, no runtime engine / no `prisma generate` step, excellent type inference (`$inferSelect`/`$inferInsert`).
- **All PKs are `uuid` defaulted to `gen_random_uuid()`** (built into Postgres 16, no `pgcrypto`).
- **Every datetime is `timestamptz`.** Never naive.
- **Email uniqueness is case-insensitive:** unique index on `lower(email)`, and all lookups use `lower(...)`.
- Cascade: sessions/credentials/schedules/runs `ON DELETE CASCADE` from `users`. `audit_log.user_id` is `ON DELETE SET NULL` (events survive account deletion).
- **Never bypass Drizzle** for feature queries (no raw `pool.query` except the `select 1` health check and migrations). **Never edit a committed migration** — generate a new one.

### D3 — Auth: Argon2id + signed cookie + DB-backed sessions (NO JWT)
- Password hashing: **Argon2id via `@node-rs/argon2`** (Rust-backed, fast). OWASP 2024 params: `memoryCost 19456` (19 MiB), `timeCost 2`, `parallelism 1`. **Not bcrypt.**
- Sessions are **server-side, DB-backed.** The cookie holds only the session UUID; the `sessions` table is the source of truth. **No JWT** — revocable instantly by deleting the row, no signing-key drama, no oversized cookies.
- Cookie: name `sid`, `httpOnly`, `SameSite=Strict`, **signed** (HMAC via `SESSION_SECRET` through `cookie-parser`), `Secure` in production only, `maxAge` 30 days, `path /`.
- Session lifetime: 30-day absolute; `last_used_at` bumped on each authed request (best-effort, non-blocking).
- Auth surface: `POST /auth/signup`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`. Zod-validated, `.strict()`. Password min 12 chars.
- **Timing-equalized login:** if the email doesn't exist, still run an Argon2 verify against a dummy hash so response time doesn't reveal account existence. Always return the generic `"Invalid email or password"`.
- Email stored as entered, lowercased+trimmed for lookup/storage on the way in.
- Audit every auth event: `signup`, `login_success`, `login_failure`, `logout` with IP + user-agent. Login failures store a non-reversible `emailHash` tag, never the email.

### D4 — Per-user credentials encrypted with AES-256-GCM
- The four secrets (Sprout username, Sprout password, Gmail address, Gmail App Password) are stored encrypted in a one-row-per-user `credentials` table.
- **AES-256-GCM**, key from `APP_ENCRYPTION_KEY` (32 bytes as 64 hex chars, env-only — never in DB).
- **Self-contained ciphertext format:** `base64url( version(1 byte, 0x01) || iv(12 bytes, random) || tag(16 bytes) || ciphertext )`. The version byte makes future key/algo rotation explicit. Exact spec + code: `reference/crypto-and-otp-specs.md`.
- All crypto lives in `src/lib/encryption.ts`. **Touching a `*_enc` column anywhere else is a bug.**
- `PUT /credentials` is a **partial update**: field omitted = leave unchanged; field = string = encrypt & set; field = `null` = clear. Response **never** echoes secrets — non-secret fields (sprout username, gmail email) are returned decrypted for display; passwords are returned only as boolean `*Set` flags.
- Audit records *which fields changed*, never values.

### D5 — Multi-tenant Playwright automation, split by concern
- v1's monolith is split into `src/automation/{browser,portal,login,clock,screenshot,otp-bridge,runAutomation}.ts`.
- **Per-user storage state:** `data/sessions/<userId>/storage-state.json`. **Per-user/per-run screenshots:** `data/screenshots/<userId>/<runId>/...`. Never a shared path.
- Creds are decrypted **once** at run start and passed into `runAutomation` as plaintext args; they live in memory only for the run's duration. Never logged, never on `req` past start.
- **Don't import `playwright` outside `src/automation/`.** Routes → `services/runs.ts` → `automation/`.
- HRHub invariants (load-bearing, see `reference/hrhub-automation-playbook.md`): **1920×1080 viewport**; **CSS-class selectors not text**; **different success-dialog titles for in vs out**; **reload after OTP** before clocking; **already-clocked guard fails safe (skip on doubt)**.
- Per-run OTP bridge is a `Map<runId, resolver>` (not a module-global) so concurrent users are safe.

### D6 — Run queue: DB partial-unique-index + in-memory FIFO concurrency cap
Two *independent* mechanisms solving two *different* problems — do not merge them:
1. **Per-user singleton (correctness):** a Postgres **partial unique index** `runs_one_active_per_user ON runs(user_id) WHERE status IN ('pending','running')`. Insert a `pending` row; if a second insert races, Postgres raises `23505` and the app returns `409 already_running`. **Never** do `SELECT WHERE running` then `INSERT` — that loses to races.
2. **Global Chromium cap (resource):** an in-memory FIFO queue with a counter, capped at `MAX_CONCURRENT_RUNS` (default 3). Each Chromium is ~300 MB; a 2 GB VPS handles ~3–4. Don't raise the cap without measuring memory.
- In-memory (not DB-backed) queue is deliberate: at this scale a `SKIP LOCKED` job runner is over-engineering, and a dead process can't resume a dead browser anyway.
- **Startup orphan recovery:** on boot, mark any leftover `pending`/`running` rows as `failure` with `error = "Interrupted by server restart"` — otherwise the unique index blocks that user forever, and the restart is invisible to them.
- The queue executor is registered **once at module load** (importing `services/runs.ts` for its side effect). Routes call `startRun`/`enqueue`, never `runAutomation` directly. HTTP responds `202` immediately; the client polls `GET /runs/:id`.

### D7 — OTP via Gmail IMAP App Password, racing a manual paste fallback
- OTP retrieval polls **Gmail IMAP** (`imap.gmail.com:993`, TLS) using the user's **App Password** — not OAuth. OAuth pushes Google Cloud Console + consent-screen review onto the operator; App Passwords push ~5 minutes of one-time setup onto the user and then never expire. For ≤50 colleagues this is the right trade.
- The executor **races** `pollForOtp` (IMAP) against `waitForOtp` (manual `POST /runs/:id/otp`) with `Promise.any`; first to resolve wins, the loser is aborted (`AbortController` for IMAP, `cancelWait` for the bridge).
- IMAP search: messages `SINCE` now − 5 min (epoch math), newest 5 UIDs, parse MIME with `mailparser` (base64/HTML bodies otherwise hide the digits), extract code with regex **`(?<!\d)(\d{4,6})(?!\d)`** preferring 5-digit matches. Poll every 5 s up to a 5-min deadline.
- `POST /credentials/test-imap` does connect → select INBOX → logout and returns `{ ok, messageCount }` or a **humanized** error (raw imapflow errors leak internals). All IMAP code lives in `src/lib/imap-otp.ts`; don't import `imapflow` elsewhere.

### D8 — Per-user node-cron scheduler, lazy opt-in, Manila + Mon–Fri
- Each enabled `schedules` row registers **two** `node-cron` tasks (in + out), pinned to **`Asia/Manila`** via cron's `timezone` option, firing **Mon–Fri** via the cron expression's `1-5` field (weekday filtering is in the expression, *not* the handler).
- `timeToCronExpression("05:30")` → `"30 5 * * 1-5"`.
- **Lazy opt-in:** new users get **no schedule row.** `GET /schedule` returns sensible defaults (05:30 / 18:05) with `configured:false, enabled:false`. Only `PUT /schedule` creates a row. Rationale: never auto-clock someone who hasn't explicitly opted in.
- Mutations cancel + re-register the user's tasks atomically (`registerSchedule` calls `unregisterSchedule` first). Boot calls `loadAllSchedules()` to rehydrate enabled rows.
- The cron handler **never throws across the boundary** (log and continue), **doesn't await execution** (fires "intent"; the queue owns "actual clocking"), and does the **holiday check at fire time** (not at registration — so a holiday-data update doesn't require re-registering).
- In-process cron means a dead process drops that day's firings; the next day is recovery. Acceptable for daily attendance.

### D9 — PH holiday skip via the `date-holidays` package (not a hardcoded list)
- Holiday lookup uses `new Holidays("PH")`. Holidays of type `"public"` or `"bank"` trigger a skip; observances are ignored.
- An `EXTRAS` override map (ISO date → name) is a manual safety valve for proclamation-only days the library hasn't shipped yet. Add as you become aware; remove when upstream catches up.
- `isPhilippineHoliday(date?)` checks `EXTRAS` first, then the library. `manilaDateString(date)` formats the date in Asia/Manila via `Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" })`.
- All holiday logic lives behind `src/lib/ph-holidays.ts`; don't import `date-holidays` elsewhere.
> ⚠️ This supersedes the original "hardcoded 2025–2027 maps" approach. Use `date-holidays`.

### D10 — HTTP hardening: Helmet strict CSP + rate limits + trust proxy + body cap
- **Helmet** with a strict CSP: `default-src 'self'`, `script-src 'self'` (no inline scripts), `style-src 'self' 'unsafe-inline'` (shadcn needs inline styles), `img-src 'self' data:`, `connect-src 'self'`, `font-src 'self' data:`, `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`, `form-action 'self'`. HSTS max-age 1y, includeSubDomains.
- Rate limits (`express-rate-limit`, keyed by IP): `/auth/login` + `/auth/signup` → **10 / 15 min**; `/credentials`, `/schedule`, `/runs` → **120 / min**. `/health` is unthrottled (uptime checks).
- `app.set("trust proxy", 1)` — exactly one reverse-proxy hop (Caddy/Traefik).
- `express.json({ limit: "100kb" })`.
- **CSRF tokens are deliberately deferred** — `SameSite=Strict` + same-origin SPA covers the threat today. Revisit only if cross-origin OAuth callbacks are ever added. (Do not add a CSRF layer in the rebuild unless you also add cross-origin flows.)
- SPA + API share one origin, so **no CORS**.

### D11 — Frontend: React + Vite + TS + Tailwind + shadcn/ui, TanStack Query for all server state
- The SPA is built by Vite and served as static files by Express from `./public` in production. In dev, Vite (port 5173) proxies API paths to the backend (port 3000).
- **TanStack Query owns all server state.** `useQuery` for reads, `useMutation` for writes, `queryClient.invalidateQueries` after mutations. Local `useState` is for **ephemeral UI only** (form inputs, expanded rows). No prop-drilling of server data, no manual `useEffect` polling loops.
- Auth state is just `useMe()` (a query); `AuthGate` renders `Dashboard` or `AuthPage` from it.
- **The one prescriptive frontend rule (this caused a real bug):** inside an `async` handler with `try/catch`, you **must** use `await mutation.mutateAsync(...)`. Never call fire-and-forget `mutation.mutate(...)` and expect the `catch` to fire. Full rule + examples in `03-CONVENTIONS-AND-GUARDRAILS.md`.

### D12 — Deploy: single VPS, Docker Compose, Caddy for TLS
- Target: **Hetzner CPX21** (**4 GB**, 3 vCPU, Singapore — closest to Manila), Ubuntu 24.04, ~$8/mo. The 4 GB (vs the 2 GB CPX11) is for headroom: 3 × Chromium (~300 MB each) + Postgres + Node + Caddy exceeds 2 GB at the 5:30 AM stampede. On 2 GB, drop `MAX_CONCURRENT_RUNS` to 2. Alternatives rejected: RackNerd (flaky), DigitalOcean (overpriced).
- Two containers via `docker-compose.yml`: `postgres:18-alpine` + the backend (built on the Playwright base image). A prod overlay adds a `caddy:2-alpine` container for automatic Let's Encrypt TLS, and stops exposing the backend port publicly.
- Backend Dockerfile is multi-stage: a `node:22-alpine` stage builds the frontend with pnpm → its `dist` is copied into the runtime image's `./public`; the runtime stage is `mcr.microsoft.com/playwright:v1.60.0-noble`, runs as non-root `pwuser`, and starts with `pnpm exec tsx src/index.ts`.
- Daily `pg_dump` backups; off-host encrypted copies recommended.

### D13 — Express 5 (async errors reach the error handler)
- Use **Express 5**, not 4. Express 5 awaits async route handlers and routes a rejected promise to the error-handling middleware. On Express 4, a `throw` inside an `async` handler is an unhandled rejection — it bypasses the global error handler and, under Node's default, can terminate the process. Several handlers legitimately throw (e.g. signup rethrowing a non-`23505` DB error, `if (!row) throw`), so this is a real correctness fix, not cosmetic.
- The SPA catch-all route is a **regex** (negative-lookahead on the API prefixes), which is compatible with Express 5's stricter path syntax (don't use a bare `"*"` string path).
- Handlers still validate with Zod and respond explicitly; D13 just makes the "never throw across the boundary unhandled" rule actually hold instead of being a footgun.

### D14 — Supply-chain hardening: pnpm 11 + gitleaks + CI
- Package manager is **pnpm 11** (via Corepack), chosen for two on-by-default protections against the shai-hulud class of npm supply-chain attacks: **`allowBuilds`** (dependency lifecycle/build scripts are refused unless explicitly allow-listed — neutralizes malicious `postinstall`) and **`minimumReleaseAge`** (won't install a version published in the last N minutes — dodges the live-compromise window). Settings live in `pnpm-workspace.yaml` (pnpm 11 makes `.npmrc` registry/auth-only).
- `pnpm-lock.yaml` is committed; all CI/Docker installs use `--frozen-lockfile`.
- **gitleaks** pre-commit hook blocks secret commits; a **minimal CI** (typecheck + vitest + `pnpm audit`) is the only thing that type-checks prod code (the backend runs via `tsx` with no compile step). Full configs: `reference/supply-chain-and-ci.md`.
- "Latest version" is explicitly **not** treated as "safe" — a fresh release is the dangerous case; the cooldown is the mitigation.

### D15 — Frontend pinned to React 18 / Tailwind 3 (with a documented upgrade path)
- The frontend targets **React 18.3 + Tailwind 3** deliberately, matched to the current local model's **late-2024 training cutoff** — a model with no React-19/Tailwind-4 patterns in training fights those stacks even with docs. React 18.3 / Tailwind 3 are maintained and not a security liability, so there's no urgency.
- The full migration to **React 19 + Tailwind 4 + shadcn-latest** is specced in `UPGRADE-PATH-react19-tailwind4.md`; do it when running a model whose cutoff is ≥ mid-2025. The app logic (hooks, api, panels, mutation rule) is unaffected by that upgrade — only deps + Tailwind setup change.

---

## Architecture at a glance

### Component diagram
```
                 ┌─────────────── VPS (Docker Compose) ───────────────┐
   Browser ──TLS─┤  Caddy (prod only) ──▶ Backend (Express, tsx)       │
                 │                          ├─ static SPA (./public)   │
                 │                          ├─ JSON API (/auth …)      │
                 │                          ├─ node-cron (in-process)  │
                 │                          ├─ RunQueue (in-memory)    │
                 │                          └─ Playwright Chromium ×N  │
                 │                                   │                  │
                 │                          Postgres 18 (sibling)      │
                 │                          data volume: sessions/,    │
                 │                                       screenshots/  │
                 └─────────────────────────────────────────────────────┘
                                          │
                              IMAP ───────┘────▶ imap.gmail.com:993 (per-user App Password)
                              HTTP ────────────▶ Sprout HRHub portal
```

### Backend module layout (target)
```
app/backend/src/
├── index.ts                 # express app, middleware order, routes, static SPA, startup sequence
├── config.ts                # Zod-validated env → exported `config`
├── db/
│   ├── schema.ts            # Drizzle tables + inferred types
│   ├── client.ts            # pg Pool + drizzle(db)
│   └── migrate.ts           # `tsx src/db/migrate.ts` runner
├── lib/
│   ├── encryption.ts        # AES-256-GCM (the ONLY place touching *_enc)
│   ├── passwords.ts         # Argon2id hash/verify
│   ├── sessions.ts          # create/find/delete/purge DB sessions
│   ├── cookies.ts           # set/clear/read signed `sid` cookie
│   ├── audit.ts             # recordAudit(event, ctx)
│   ├── paths.ts             # per-user/per-run filesystem paths
│   ├── imap-otp.ts          # IMAP test + poll + OTP regex + humanizer (ONLY place importing imapflow)
│   └── ph-holidays.ts       # date-holidays wrapper + manilaDateString (ONLY place importing date-holidays)
├── middleware/
│   ├── auth.ts              # attachUser (every request) + requireAuth (guard)
│   └── security.ts          # helmet CSP + rate limiters
├── automation/              # the ONLY place importing playwright
│   ├── browser.ts           # launch + per-user context + saveStorageState
│   ├── portal.ts            # navigate + isLoggedIn + isOnOtpPage
│   ├── login.ts             # performLogin + handleOtp
│   ├── clock.ts             # isAlreadyClockedForToday + performClockAction
│   ├── screenshot.ts        # per-user/per-run screenshot helper
│   ├── otp-bridge.ts        # Map<runId, resolver> manual-OTP bridge
│   └── runAutomation.ts     # orchestrates a single run
├── services/
│   ├── run-queue.ts         # RunQueue class + recoverOrphanedRuns
│   ├── runs.ts              # startRun + executeQueuedRun (+ registers executor) + list/get/otp
│   └── scheduler.ts         # node-cron register/unregister/load + fireCron
└── routes/
    ├── auth.ts              # /auth/*
    ├── credentials.ts       # /credentials/* (incl. test-imap)
    ├── runs.ts              # /runs/* (incl. queue/stats, :id/otp)
    └── schedule.ts          # /schedule
```

### Middleware order in `index.ts` (this order matters)
```
trust proxy = 1
helmet (securityHeaders)
express.json({ limit: "100kb" })
cookieParser(SESSION_SECRET)
attachUser                       # populates req.user from the session cookie, every request
rate limiters (per path prefix)
GET /health
routers: /auth /credentials /runs /schedule
static ./public + SPA catch-all (regex excludes the API prefixes)
global JSON error handler (never leak stack traces)
```

### Startup sequence (`main()` in `index.ts`)
```
1. await db.execute(`select 1`)            # fail fast if DB unreachable
2. recoverOrphanedRuns()                   # orphaned pending/running → failure
3. log run-queue cap
4. loadAllSchedules()                       # rehydrate enabled crons
5. app.listen(PORT, "0.0.0.0")
(on fatal error: end pool, process.exit(1))
```

## Data model summary

Six tables. Full Drizzle source: `reference/database-schema.md`.

| Table | One row per | Holds | Key constraints |
|-------|-------------|-------|-----------------|
| `users` | account | email, `password_hash`, `email_verified_at`, `is_admin`, timestamps | unique index on `lower(email)` |
| `sessions` | login session | `user_id`, `expires_at`, `last_used_at`, ip, ua | FK cascade; indexes on user & expiry |
| `credentials` | user | the four `*_enc` blobs | `user_id` unique; FK cascade |
| `schedules` | user | `clock_in_time`, `clock_out_time` (`time`), `enabled` | `user_id` unique; FK cascade |
| `runs` | execution | `action` in/out, `status`, `login_method`, `error`, `steps` jsonb, started/finished | **partial unique index on `user_id WHERE status IN ('pending','running')`**; indexes on user & started |
| `audit_log` | event | `event_type`, ip, ua, `metadata` jsonb | FK **set null**; indexes on user, event, created |

---

## ⚑ Recommended improvements over the as-built version

These are *my* recommendations as the senior engineer. Items 1, 2 (and the gitleaks + CI items) are now **ADOPTED into the baseline build** for the fresh rebuild; the rest remain optional per-phase callouts. None of the optional ones are required for a working system; all are cheap wins.

1. ✅ **ADOPTED — Structured logging (`pino`) instead of `console.log`.** `pino` (+ `pino-http` for request logging with a `requestId`) is in the dependency list and set up in Phase 0. Redact a fixed key list (`password`, `appPassword`, `gmailAppPassword`, `otp`, `code`, `sid`, `APP_ENCRYPTION_KEY`, `SESSION_SECRET`). Makes the "never log secrets" rule enforceable via the redaction config.

2. ✅ **ADOPTED — A `vitest` test track for pure functions.** `vitest` is in the dep list + CI. Cover the brittle pure logic where a local LLM is most likely to introduce a subtle bug: `encryption` round-trip + version-byte rejection, `extractOtpCode` (prefers 5-digit, ignores long numbers), `timeToCronExpression`, `manilaDateString`/`isPhilippineHoliday`. "Write the test from the spec, then make it pass" gives the model a concrete success signal. *Add per phase as those functions are written.*

   ✅ **ADOPTED — gitleaks pre-commit + minimal CI (typecheck/test/audit) + pnpm 11 supply-chain hardening.** See **D14** and `reference/supply-chain-and-ci.md`. These were "Phase 4 deferred" in the original roadmap; pulled to commit 1 because the tsx-no-compile choice makes the typecheck gate essential and the shai-hulud risk is live.

3. **Pull email verification + password reset into Phase 4 properly (not "someday").** The roadmap defers these, but you're hosting real colleagues. Pick a transactional email provider (Resend is the simplest) and implement: verify-on-signup (single-use token, 24 h) and password reset (single-use token, 1 h, invalidates all sessions on use). Gate sensitive actions on `email_verified_at`. *Recommended before inviting >3 people.*

4. **Idle session timeout in addition to the 30-day absolute.** As-built only has the absolute lifetime. Add a 7-day idle timeout: on each request, if `now - last_used_at > 7d`, treat the session as expired. Cheap, and limits the blast radius of a stolen cookie.

5. **Type the `useRuns` refetch callback.** As-built uses `(query: any)`. Type it with TanStack's `Query` generics (or read `query.state.data` through a typed helper). Tiny, but it removes the one `any` in the data layer and models good practice for the LLM.

6. **A distinct `credentials_deleted` audit event.** As-built logs deletion as `credentials_updated` with `fields:["deleted_all"]`. A dedicated event type reads better in the audit trail. Trivial.

7. **A `QueryClient` with explicit defaults.** As-built constructs `new QueryClient()` bare. Set sensible defaults (`staleTime: 30_000`, `retry: 1`, and `retry: false` specifically for `useMe` so an unauthenticated 401 doesn't retry-storm). Prevents subtle refetch behavior the model would otherwise have to reason about ad hoc.

If you want a leaner first pass, skip all seven and build exactly as-built — the system works without them. They're ordered roughly by value.
