# Phase T — Test Harness

> ⚠️ **As-built (found 2026-08):** Several things diverged from this spec during the build. (1) vitest 2.1.9's workspace API is a `vitest.workspace.ts` file with `defineWorkspace`, **not** `test.projects` (that's v3+). (2) The integration project MUST run in a single fork (`poolOptions.forks.singleFork: true`) — parallel files race to create the drizzle schema AND truncate the shared `sprout_test` DB against each other. (3) `qc.clear()` on logout empties the cache but does not notify the `["me"]` observer in AuthGate, so the Dashboard never unmounts; the frontend `useLogout` now calls `qc.resetQueries()` instead (this was a real pre-existing bug the e2e smoke caught). (4) The executor registration moved from `services/runs.ts` module-load into `index.ts` `start()` — that's the only way to honor T1's "a route test should not be able to launch Chromium", since `app.ts` transitively imports `services/runs.ts` via `routes/runs.ts`. (5) The e2e `webServer` script (`app/frontend/e2e-server.mjs`) builds the SPA into `app/backend/public` and migrates `sprout_test` before booting, so `pnpm test:e2e` needs Postgres running — it is not database-free like the unit suite.

**Runs BEFORE phase 6.** "T" not a number, because it is infrastructure rather than a product phase — it is the thing that makes every later gate able to say *no*.

**Goal:** the ability to test routes, the database, and the SPA at all. Today the suite is 11 cases over four pure functions; there is no way to make an authenticated request in a test, no test database, and no e2e setup. Every high-value test in `reference/testing-strategy.md` is currently a *description* of a test that does not exist.

**Attach for this session:** `03-CONVENTIONS-AND-GUARDRAILS.md`, `reference/testing-strategy.md`, `reference/database-schema.md`, `reference/api-contract.md`, `reference/live-docs-and-mcp.md`.

> 📡 **Fetch live docs first (Context7):** **vitest** — the unit/integration split API has changed across recent majors (`workspace` vs `projects`), so do **not** write that config from memory. Also **Playwright test runner** config (distinct from the `playwright` library the automation already uses).

> **No new runtime dependencies.** Test-only devDependencies are acceptable where unavoidable, but **do not add `supertest`** — the harness starts the real app on an ephemeral port and uses `fetch`, which tests the actual HTTP stack including cookies and matches how the frontend calls it.

---

## T1 — Make the app importable

`src/index.ts` currently builds the Express app *and* calls `start()` at module load. Importing it to test a route would boot a listening server and register every user's cron tasks. Split it:

- **`src/app.ts`** — everything that builds the app: middleware order, routers, `/health`, static SPA, catch-all, global error handler. Exports `export const app`. **No `listen`, no `recoverOrphanedRuns`, no `loadAllSchedules`.**
- **`src/index.ts`** — imports `app`, keeps `start()` (orphan recovery → `loadAllSchedules()` → `app.listen`) and the top-level `start().catch(...)`.

Preserve the middleware order exactly as it is (`02` § "Middleware order"); this is a move, not a redesign. The side-effect import of `./services/runs` (which registers the queue executor) stays with the startup path in `index.ts`, **not** in `app.ts` — a route test should not be able to launch Chromium.

**Gate T1:** `pnpm typecheck` clean; `pnpm dev` still serves `/health`; the Docker image still boots (`docker compose up -d --build`, `curl --noproxy '*' http://127.0.0.1:3000/health`). `[manual]` for the Docker check.

---

## T2 — Integration harness (test database + authenticated requests)

### Split the suite in two

Unit tests must keep running with **no database at all** — they are the fast feedback loop. Integration tests need a real Postgres. Configure two vitest projects (fetch the current API — this is the part that has changed):

- `unit` — `test/lib/**`, `test/services/**` (pure). Env from the existing `vitest.config.ts` dummies.
- `integration` — `test/integration/**`. Overrides `DATABASE_URL` to a **separate database** (e.g. `sprout_test`), never the dev one.

Scripts in `package.json`:

```json
"test": "vitest run --project unit",
"test:integration": "vitest run --project integration",
"test:all": "vitest run"
```

`pnpm test` staying database-free is deliberate: a gate that needs Docker running is a gate people skip.

### The harness itself — `test/integration/harness.ts`

1. **`setupDatabase()`** — global setup. Point `DATABASE_URL` at `sprout_test`, run the Drizzle migrator against it (same `migrate()` as `src/db/migrate.ts`; **never** hand-write schema in tests — a drifted test schema is worse than no test). Fail loudly with a clear message if the database is unreachable, so a missing `docker compose up -d postgres` is obvious rather than a cascade of confusing failures.
2. **`resetDatabase()`** — between tests: `TRUNCATE users, runs, sessions, credentials, schedules, audit_log RESTART IDENTITY CASCADE`. Truncating `users` cascades to everything owned by a user, which is exactly the FK topology in `reference/database-schema.md`. Fast and total; do not delete row-by-row.
3. **`startTestServer()`** — `app.listen(0)` for an ephemeral port; return the base URL and a `close()`. One server for the file, not per test.
4. **`createUser({ email?, password? })`** — signs up through the real `POST /auth/signup` and returns `{ user, cookie }`. Going through the real route means the test exercises Argon2, session creation, and the signed cookie rather than a fixture that can drift from them.
5. **`request(path, { cookie?, method?, body? })`** — thin `fetch` wrapper returning `{ status, body, headers }`, sending the `sid` cookie when given. This is what every route test uses.

> **`createUser` is the piece everything else depends on** — two users, two cookies, is the entire setup for a tenant-isolation test.

### First tests, in this order

Write them **from `reference/testing-strategy.md`'s ranked list**, highest value first. These are the reason the harness exists:

1. **The race guard.** Fire N concurrent `POST /runs` for one user → exactly one `202`, the rest `409 already_running`. Then finish the run and prove a new one is accepted. Point `SPROUT_URL` at a dead local port (e.g. `http://127.0.0.1:9/`) so enqueued runs fail fast at navigation instead of touching real HRHub — the 1×202 / N−1×409 split is decided at `startRun` regardless of what the automation then does.
2. **Tenant isolation.** Two users; A's cookie must not read or mutate B's runs, credentials, schedule. **Table-drive it over the route list**, so a route added later without scoping fails the suite rather than passing unnoticed.
3. **Secret shape.** `GET /credentials` exposes no key matching `/password/i` holding a string; `/auth/me` has no `passwordHash`. Assert on shape, not on specific values — it catches the whole class.
4. **Credential partial-update.** omit / string / `null` per field, asserting each field independently so "setting one wipes another" cannot pass.
5. **Lazy opt-in.** `PUT /schedule` omitting `enabled` on a fresh insert must leave it `false`, despite the column defaulting to `true`.
6. **Orphan recovery.** Insert a `running` row, call `recoverOrphanedRuns()`, assert `failure` + the restart message, and that the user can start a new run.

**Gate T2:** `pnpm test` green with **Postgres stopped** (proves the unit suite is genuinely database-free). `pnpm test:integration` green with Postgres running. Deliberately break tenant scoping in one route → the isolation test fails. Deliberately remove the `enabled: false` override in the schedule route → the lazy-opt-in test fails. **A test that cannot fail is not a test — prove each one can.**

---

## T3 — E2E

`app/frontend/playwright.config.ts` + `app/frontend/e2e/`, with `"test:e2e": "playwright test"` in the frontend `package.json`. (That script is referenced elsewhere in these docs and **does not exist yet** — this creates it.)

Config: `webServer` starting the built SPA + backend, `baseURL`, one Chromium project, `viewport` at desktop plus a 375px mobile project for the responsive checks.

One smoke flow is enough here — depth belongs in the integration suite, which is faster and more precise:

> sign up → save Sprout credentials → save a schedule with "run automatically" enabled → reload and confirm both persisted → log out → log back in → confirm still there.

Do **not** e2e the automation itself. It needs real HRHub credentials and real OTP delivery; that stays `[manual]`.

**Gate T3:** `pnpm test:e2e` green against the built app; the same flow passes in the 375px project (this doubles as the responsive regression check); no test contains a real credential.

---

## Phase gate

```bash
cd app/backend  && pnpm typecheck && pnpm test          # no database needed
cd app/backend  && pnpm test:integration                 # needs docker compose up -d postgres
cd app/frontend && pnpm test:e2e
```

Plus `[manual]`: the Docker image still builds and serves `/health`.

Then update `rebuild/STATE.md` (the "Known gaps" entry about untested properties shrinks to whatever is genuinely still uncovered) and `reference/testing-strategy.md` if any layer ended up structured differently from what it describes.
