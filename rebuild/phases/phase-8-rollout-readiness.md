# Phase 8 — Rollout readiness (single-operator → ~30 users)

**Goal:** close the five things that stop this being safe to hand to a team. Every item here is already in `BACKLOG.md`; this file is the executable spec for them, in dependency order.

**Why now:** the app has run for one person on one machine. The gap between that and thirty colleagues is not features — it is a rate limiter that locks out a shared NAT, a compose file that silently discards the config you would use to fix it, no way to see whose automation is broken, a screenshots directory that grows without bound, and in-app copy that never mentions the tool only works with Gmail.

**Attach for this session:** `03-CONVENTIONS-AND-GUARDRAILS.md`, `reference/api-contract.md`, `reference/database-schema.md`, `reference/testing-strategy.md`, `phases/phase-4-security.md` (§ 4A.2 for the allowlist pattern this mirrors, § 4B.7 for the admin sketch).

> 📡 **Fetch live docs (Context7):** `express-rate-limit` v7 (`keyGenerator`, `store`, `standardHeaders: "draft-7"`), `node-cron`, Docker Compose spec (environment interpolation). Do not write these from memory.

**Order is load-bearing.** 8A unblocks 8B and 8C — every later gate adds a config key, and a key that never reaches the container is a key that does nothing. Do not reorder.

---

## 8A — Compose passes the whole environment (`BACKLOG.md` § 4)

**The defect.** `config.ts` reads fourteen env keys. `docker-compose.yml`'s `backend.environment` block passes seven: `NODE_ENV`, `PORT`, `DATABASE_URL`, `APP_ENCRYPTION_KEY`, `SESSION_SECRET`, `DATA_DIR`, `SPROUT_URL` (plus `TZ`, which is not a config key). Setting any of the other seven in the root `.env` **does nothing under Docker, with no warning** — the container never sees them, so each silently falls back to its default.

Missing: `APP_URL`, `AUTH_RATE_LIMIT`, `MAIL_FROM`, `MAX_CONCURRENT_RUNS`, `MISSED_RUN_GRACE_MINUTES`, `RESEND_API_KEY`, `SIGNUP_ALLOWED`.

**Contract:**
- Add all seven to `docker-compose.yml` `backend.environment` using `${KEY}` interpolation. **Do not invent defaults in compose** where `config.ts` already has one — `${AUTH_RATE_LIMIT}` not `${AUTH_RATE_LIMIT:-10}`, so `config.ts` stays the single source of truth for defaults and an unset key behaves identically inside and outside Docker.
- Do the same in `docker-compose.prod.yml` for any key it overrides, without disturbing its `NODE_ENV=production` or the `ports: !reset []` backend override.
- **Every config key added by a later gate in this phase must be added here in the same commit.** This is the trap the whole gate exists to close; do not reintroduce it.

**Repo hygiene, same gate.** A tracked file `jar` at the repo root is a curl cookie jar containing a live `sid` session cookie, committed in `a81c96d`. `git rm jar`, and widen `.gitignore` — the existing `cookies.txt` entry did not match it. Add `jar`, `cookie*`, `*.cookies`. Do not rewrite history.

**Gate 8A:**
```
docker compose config | grep -E "APP_URL|AUTH_RATE_LIMIT|SIGNUP_ALLOWED|MAX_CONCURRENT_RUNS|MISSED_RUN_GRACE_MINUTES|RESEND_API_KEY|MAIL_FROM"
cd app/backend && pnpm lint && pnpm typecheck && pnpm test
git ls-files jar          # must print nothing
```
`docker compose config` renders the resolved file — all seven must appear under the backend service.

---

## 8B — Auth rate limiting that survives a shared NAT (`BACKLOG.md` § 3)

**The defect.** `authLimiter` (`middleware/security.ts:67`) is `AUTH_RATE_LIMIT` (default **10**) requests / 15 min **keyed by IP**, shared across login, signup, forgot-password and reset. Thirty colleagues on one corporate network share one IP: they exhaust the budget in seconds and everyone after that gets "Too many attempts" on their first attempt of the day, with nothing telling them a colleague caused it.

**The decision is made — implement this one, do not re-evaluate the alternatives.** Key by email with a looser IP backstop. Raising the budget alone only moves the wall; a brute-forcer targets an account, not an IP, so per-IP is the wrong key for the primary limit.

**Contract:**
- **Two limiters on the auth routes, both must pass:**
  - **Per-account:** 5 requests / 15 min, keyed on the **submitted, lowercased** email. Must apply on the "no such user" path too, or the limiter becomes an account-existence oracle. Where a request carries no email (e.g. reset-by-token), skip this limiter rather than keying on `"anon"`.
  - **Per-IP backstop:** `AUTH_RATE_LIMIT` / 15 min, **default raised 10 → 30**.
- Follow the existing per-user pattern in `notificationsTestLimiter` (`security.ts:95`) for `keyGenerator` — it is the precedent for keying on something other than IP, including the v7 option name.
- Both stores must be resettable via the existing `resetRateLimits()` export, and the integration harness must reset both.
- **The 429 body must not reveal which limiter fired** — same `{ error: "Too many attempts. Please try again later." }` either way. A distinguishable message tells an attacker whether the account exists.
- `AUTH_RATE_LIMIT` must reach the container (8A).

**Tests (integration):**
- 6th login attempt for one email → 429, **while a different email from the same IP still succeeds**. This is the property the whole change exists for; it must fail against the current IP-only implementation.
- Per-IP backstop still fires at 31 across distinct emails.
- Email keying is case-insensitive: `A@x.com` and `a@x.com` share a budget.
- A failed login for a **non-existent** account consumes the per-account budget (no oracle).
- Both 429 bodies are byte-identical.

**Gate 8B:** `cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration`

---

## 8C — Admin visibility (`BACKLOG.md` § 8)

**The defect is bigger than the backlog says.** `is_admin` exists in `db/schema.ts:24`, is returned by `publicUser` (`routes/auth.ts:75`), and is typed in `frontend/src/api.ts:19`. **Nothing sets it and nothing reads it.** There is no `requireAdmin`, no admin route, no seed, no grant path — so there is currently no way for anyone, including the operator, to become an admin. The column is inert and always `false`.

So this gate is two things: a way to *be* an admin, then something to *see*.

**Contract — granting:**
- New config key **`ADMIN_EMAILS`** — comma-separated exact addresses, matched case-insensitively against the already-lowercased email. Same parsing shape as `SIGNUP_ALLOWED` (`lib/signup-allowlist.ts`) but **exact addresses only — no domain entries**. A domain entry would make everyone at the company an admin; that mistake must be impossible, so reject an entry without `@` at config load with a message naming the fix.
- **Config is authoritative, reconciled at boot.** On startup, set `is_admin = true` for users whose email is listed and `false` for those not listed. This makes both granting *and* revoking a config change, and means a wrong entry cannot be silently persisted in the database. Log the count changed, never the addresses.
- Optional in dev (empty = no admins). **Not** required in production — an operator running this alone needs no admin.
- Add to `.env.example` **and to compose (8A)**.

**Contract — `requireAdmin`:**
- New middleware in `middleware/` returning **404**, not 403, for a non-admin. A 403 confirms the endpoint exists; there is no reason to tell a normal user that an admin surface is there.
- Mounted after `requireAuth`, never in place of it.

**Contract — `GET /admin/overview`:**
- Admin-only. Returns, for **every** user: `id`, `email`, `emailVerifiedAt`, `scheduleEnabled`, `clockInTime`, `clockOutTime`, `pausedFrom`, `pausedUntil`, `notificationsEnabled`, and the **last run per action** (`in` and `out`) as `{ status, finishedAt, error }`.
- **This is the one endpoint in the app that legitimately reads across tenants** — call that out in a comment above the handler, because it is the single exception to AGENTS.md rule 5 and a reviewer will otherwise flag it. Everything else stays scoped to `req.user.id`.
- **Never returns credential material**: no `*_enc` column, no `*Set` booleans, no Gmail address, no bot token. `error` is the persisted run error string, which is operator-facing by design.
- Rate-limited under the existing `apiLimiter`.
- Ordered by "most broken first" — users whose latest run failed, then by email.

**Contract — frontend:**
- A fifth panel, rendered **only when `me.isAdmin`**. A table: email, schedule, last in, last out, each status as the existing status badge. Read-only — no impersonation, no credential access, no editing another user's anything.
- Uses TanStack Query like every other panel (`useAdminOverview`); no `useState` for server data.
- Responsive: the table scrolls inside its own container at 375 px rather than making the page scroll sideways.

**Tests (integration):**
- A non-admin gets **404** from `/admin/overview`; an admin gets 200.
- An unauthenticated request gets 401, not 404 — `requireAuth` runs first.
- The payload contains no `*_enc` value, no Gmail address and no bot token, asserted against a user who has all three set.
- Boot reconciliation grants to a listed email and **revokes** from an unlisted one.
- A config with a domain-only entry (`@orchard.com.au` or `orchard.com.au`) **refuses to start**.

**Gate 8C:** `cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration` · `cd app/frontend && pnpm lint && pnpm build`

---

## 8D — Screenshot pruning (`BACKLOG.md` § 2)

**The defect.** Roughly 8 full-page PNGs per run × 2 runs/day × every user, retained forever. At 30 users that is ~480 files/day. Nothing prunes.

**Contract:**
- A nightly `node-cron` job at **03:30 `Asia/Manila`**, registered alongside the existing schedules in `services/scheduler.ts`.
- Two retentions, both config keys with defaults: **`SCREENSHOT_RETENTION_DAYS`** (default 14) for successful and skipped runs, **`SCREENSHOT_FAILURE_RETENTION_DAYS`** (default 60) for failures. Failure screenshots are the forensic record for HRHub selector drift — they are the ones worth keeping.
- Prune by **joining the run**, not by directory mtime: `data/screenshots/<userId>/<runId>/` maps to `runs.id`. Read the run's `status` and `finished_at` to pick the retention. A directory whose `runId` has **no matching row** is orphaned — prune it at the shorter retention.
- Use `screenshotDir` / `userScreenshotRoot` from `lib/paths.ts`. **Never** build the path by hand; never delete outside `config.DATA_DIR`.
- Best-effort and non-fatal: a failed unlink logs and continues. This job must never be able to fail a run or crash the process.
- Log a single summary line per sweep (directories removed, bytes freed) — never a per-file line, or the log becomes the new disk problem.
- Add both keys to `.env.example` and to compose (8A).

**Tests (unit, with an injected clock and a temp `DATA_DIR`):**
- A success-run directory older than 14 days is removed; one at 13 days is kept.
- A **failure**-run directory at 20 days is **kept**; at 61 days it is removed.
- An orphan directory with no `runs` row is removed at the short retention.
- A path outside `DATA_DIR` is never touched — assert by pointing a crafted `runId` at a traversal (`../../etc`) and confirming nothing outside the temp root is removed.

**Gate 8D:** `cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration`

---

## 8E — The Gmail-only constraint, where people actually read it (`BACKLOG.md` § 5)

**The defect.** `lib/imap-otp.ts` hardcodes `imap.gmail.com:993`. That covers Gmail *and* Google Workspace (same host, identical App Passwords) and **nothing else** — anyone whose HRHub codes arrive in Microsoft 365 needs a forwarding rule into Gmail before the tool works for them at all. `CredentialsPanel` currently contains **zero** mentions of Workspace or forwarding.

**Contract — in the app, beside the field** (this is what people read while setting up; a document is not):
- Extend the existing Gmail App Password walkthrough in `CredentialsPanel` to state plainly: the mailbox must be **Gmail or Google Workspace**; if HRHub mails a different provider, set a forwarding rule into a Gmail account and use that address here.
- Add, near the notification settings: **a missed-run alert means "the automation didn't run", not "you aren't clocked in".** Someone who clocked in by hand still gets one. Without this sentence people either panic or learn to ignore the alerts — and an ignored alert is worse than none.
- Copy only. **No new dependency, no layout rewrite, no component extraction.** Follow the existing panel's markup conventions; do not introduce a clickable link containing a token or a secret (see the dead `bot<TOKEN>` link removed from `NotificationsPanel`).

**`[manual]` — not code, listed so it is not forgotten:** the onboarding one-pager (what it does, what it stores and how it is encrypted, the ~5-minute setup, what the notifications mean, and that it clocks *you* in under *your* credentials so accuracy remains your responsibility). Human deliverable.

**Gate 8E:** `cd app/frontend && pnpm lint && pnpm build && pnpm test:e2e`

---

## Verification Gate (the whole phase)

```
cd app/backend  && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration
cd app/frontend && pnpm lint && pnpm build && pnpm test:e2e
docker compose config | grep -cE "APP_URL|AUTH_RATE_LIMIT|SIGNUP_ALLOWED|ADMIN_EMAILS|SCREENSHOT_RETENTION_DAYS"
git ls-files jar
```

**`[manual]` — must not be claimed as passed:**

| # | Check | Pass looks like |
|---|---|---|
| 1 | Set `AUTH_RATE_LIMIT=30` in `.env`, `docker compose up -d --build`, hit `/health` and read the startup log | The value is in effect — proves 8A end to end, which no test can |
| 2 | Fail login 6× for one email, then log in correctly as a **different** user from the same machine | The second user is unaffected |
| 3 | Add your address to `ADMIN_EMAILS`, restart, reload the dashboard | The admin panel appears; a second account does not see it and gets 404 from `/admin/overview` |
| 4 | Remove your address, restart | The panel is gone — revocation works |
| 5 | Admin panel at 375 px | Table scrolls inside its container; the page does not scroll sideways |
| 6 | Let the 03:30 prune run overnight with a real `data/screenshots` tree | One summary log line; failure screenshots still present, old successes gone |
| 7 | Read the new `CredentialsPanel` copy as someone who has never set this up | It is obvious the mailbox must be Google, and what to do if it isn't |

Commit per the loop in `AGENTS.md` — implementer reports, tester probes, reviewer commits. Tag `phase-8-complete` only when the `[manual]` table is filled in, since only a human can confirm rows 1–7.
