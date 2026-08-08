# Phase 4 — Security Hardening

**Goal:** lock down the HTTP layer (this part is small and you do it as soon as you have routes), then implement the account-lifecycle security features that turn this from "works for me" into "safe to hand colleagues."

**Attach for this session:** `03-CONVENTIONS-AND-GUARDRAILS.md`, `reference/api-contract.md`, `reference/database-schema.md`, `reference/live-docs-and-mcp.md`.

> 📡 **Fetch live docs first (Context7):** helmet (current CSP API), express-rate-limit v7, and — if you do the 4B email flows — the chosen mail SDK (e.g. Resend).

Split into **4A (essentials — do these the moment Phase 1 routes exist; they're cheap)** and **4B (lifecycle — do before inviting >3 people)**.

> **Commit checkpoints** — commit only on a green gate; never a red one; *you* run the commit, not the agent. Suggested messages:
> - Gate 4A → `feat(phase-4): helmet csp + rate limits + trust proxy + body cap [gate 4A]`
> - 4B is several independent features — commit each as you finish *and verify* it: `feat(phase-4): email verification [4B.2]`, `feat(phase-4): password reset [4B.3]`, `feat(phase-4): idle session timeout [4B.4]`, `feat(phase-4): account deletion [4B.5]`, `feat(phase-4): data export [4B.6]`.
> Then tag: `git tag phase-4-complete`.

---

## 4A — HTTP hardening essentials (as-built; ship these early)

Create `src/middleware/security.ts`:
- **`securityHeaders`** = `helmet({...})` with the strict CSP from D10: `defaultSrc ['self']`, `scriptSrc ['self']`, `styleSrc ['self','unsafe-inline']` (shadcn needs it), `imgSrc ['self','data:']`, `connectSrc ['self']`, `fontSrc ['self','data:']`, `objectSrc ['none']`, `baseUri ['self']`, `frameAncestors ['none']`, `formAction ['self']`; `crossOriginEmbedderPolicy:false`; HSTS `maxAge 31536000, includeSubDomains:true`.
  > ⚠️ **As-built (found 2026-07):** set `contentSecurityPolicy.useDefaults: false` so ONLY the listed directives are emitted. Helmet's defaults otherwise add **`upgrade-insecure-requests`**, which breaks the bundled SPA served over plain **http** at `http://localhost:3000` (it upgrades same-origin asset requests to https). In prod behind Caddy everything's already https, so its absence is harmless. Also, helmet 8's HSTS option key is **`strictTransportSecurity`** (`{ maxAge, includeSubDomains }`), not `hsts`. **Verify the CSP against the built SPA at :3000 (not Vite dev :5173, whose HMR uses inline/eval scripts a strict CSP blocks)** — load it in a real browser and confirm zero CSP violations in the console.
  > **Prod-run gotcha:** the base `docker-compose.yml` runs the backend with `NODE_ENV=development` (from `.env`), and `pino-pretty` is a devDependency omitted by the image's `--prod` install — so the logger must guard the pretty transport (only use it when it resolves) or the container crash-loops. Phase 5's prod compose should set `NODE_ENV=production`.
- **`authLimiter`** = `express-rate-limit` 10 / 15 min, `standardHeaders:"draft-7"`, JSON message.
- **`apiLimiter`** = 120 / min.

Wire into `index.ts` in this order: `app.set("trust proxy",1)` → `app.use(securityHeaders)` → `express.json({limit:"100kb"})` → `cookieParser` → `attachUser` → `app.use("/auth/login",authLimiter)`, `"/auth/signup"` authLimiter, `/credentials`,`/schedule`,`/runs` apiLimiter → routers. `/health` stays unthrottled.

**Locked non-decisions (do NOT add):**
- **No CSRF tokens** — `SameSite=Strict` + same-origin SPA covers it. Only revisit if you add cross-origin OAuth.
- **No CORS** — SPA and API share an origin.

**Gate 4A:** response headers show CSP + HSTS + `X-Frame-Options`/`X-Content-Type-Options`; 11 rapid bad logins → the 11th returns `429`; a `<script>alert(1)</script>` injected into a text field never executes (CSP blocks inline). Health is never rate-limited.

---

## 4A.2 — Signup gating (⚑ do this BEFORE Phase 5 exposes anything publicly)

**The hole:** anyone who reaches the URL can create an account. There is no invite code, no allowlist, no approval step. On localhost that is harmless; the moment Phase 5 puts this behind a public domain, it is the real exposure — bigger than the CSRF we correctly deferred, because it needs no attack, just the URL.

**Email verification (4B.2) does not close it.** Verification proves someone controls *some* mailbox. It says nothing about whether they should have an account on a tool that stores HRHub credentials for your colleagues.

Pick **one** and implement it in `POST /auth/signup`, before the password hash:

- **Invite code** (simplest, recommended). `SIGNUP_INVITE_CODE` in `config.ts` — a required, non-empty string in production. Signup body takes `inviteCode`; mismatch → `403 { error: "Signup is invite-only." }`. You share the code out-of-band with colleagues. Rotating it is an env change plus a restart.
- **Email allowlist (chosen — see the note below).** `SIGNUP_ALLOWED` as a comma-separated list where an entry **containing `@` is an exact address** and an entry **without one is a whole domain**: `orchard.com.au, maz.getutua@gmail.com`. Domains cover the team without distributing a secret; exact addresses cover the operator's own personal account and any one-off exception. Match case-insensitively against the already-lowercased email. It does mean anyone who can guess an address at an allowed domain can sign up, so pair it with 4B.2 verification once that exists.
  > ⚠️ **Grandfathering:** the allowlist gates *new signups only*; existing accounts keep working regardless. The operator's own account is currently a `@gmail.com` address, so without an exact-address entry a database rebuild would lock them out of their own tool. Include it.
- **Closed signup.** `SIGNUP_ENABLED=false` and you create accounts by hand. Most secure, least convenient; reasonable if the user list is final.

Whichever you choose: fail with the **same generic message** regardless of *why* (bad code vs disabled signup), audit the rejection as `signup_rejected` with the reason in metadata (never the attempted code or email — use the same non-reversible `emailHash` as `login_failure`), and apply `authLimiter` so the invite code can't be brute-forced. Add `signup_rejected` to the `AuditEventType` union.

**Gate 4A.2:** signup without the code → `403`; with it → `201`; 11 rapid wrong-code attempts → the 11th is `429`; the audit table shows `signup_rejected` rows with no code or email value in them; with signup gated, the existing signup tests still pass once updated to supply the code.

---

> Tenant isolation, secret redaction, Argon2id, AES-256-GCM, Zod `.strict()`, audit logging, and the run concurrency caps are **already built in Phases 1–2** — they are the bulk of "security" and are not deferred. 4A is only the HTTP edge.

---

## 4B — Account-lifecycle security (⚑ RECOMMENDED — pull these in for real users)

These are deferred in the original roadmap. As the senior engineer I recommend doing them before onboarding more than a couple of trusted people, because they close real holes (no way to recover an account, sessions that never idle out, no clean offboarding).

### 4B.1 — Email infrastructure
Pick a transactional email provider; **Resend** is the least-friction (`resend` npm SDK, one API key). Add `RESEND_API_KEY` + `MAIL_FROM` to `config.ts` (optional in dev — if unset, handle the email in-process instead of sending, so dev doesn't need a provider). Create `src/lib/mailer.ts` with `sendMail({to,subject,html})`.

The no-provider fallback is **environment-dependent**, not just provider-dependent:
- `NODE_ENV !== "production"` (dev/test): log the **full message including the link** at `info`. The link is the entire point of the fallback — without it a password reset cannot be completed.
- `NODE_ENV === "production"`: log **recipient + subject only** and a loud `warn` that reset emails cannot be delivered until `RESEND_API_KEY` and `MAIL_FROM` are set. Do **not** refuse to start — a self-hosted operator without mail still gets a working app, minus reset. A reset link in a production log file would be a live credential, so the body never appears here.
- Provider configured: send via Resend; **never** log the body.

Token *values* go only in the emailed (or, in dev, logged) link, never in audit metadata.
> ⚠️ **As-built (found 2026-08):** the round-1 prompt said the dev fallback must "never log the email body or any token", which made the reset flow unusable without a provider — the link was neither sent nor logged, and only its hash was stored. The correct rule is the environment-dependent one above: the full message (link included) is logged in dev, and only recipient + subject in production. Do not "tighten" the dev branch to drop the body; that re-introduces the defect.

> ⚠️ **As-built (found 2026-08, rate-limiting fix):** `POST /auth/forgot-password` and `POST /auth/reset-password` must be rate-limited (both are unauthenticated — one sends email, the other accepts an unauthenticated token). Both are now mounted behind `authLimiter` in `app.ts`. The limiter store is resettable via `resetRateLimits()` (exported from `middleware/security.ts`) and called from the integration harness, so tests can legitimately exceed the 10/15min budget without consuming a separate IP-based budget. An `AUTH_RATE_LIMIT` config key allows operators to adjust the limit (e.g., for NAT scenarios) without code changes; the default is 10 and the 11th-is-429 property is asserted in the integration suite. Shared NAT issue noted in BACKLOG.md § "rate limiting under NAT".

### 4B.2 — Email verification on signup
- New table `email_tokens` (or reuse a generic `tokens` table): `id`, `userId` (cascade), `tokenHash` (Argon2id or SHA-256 of a 32-byte random token — store the **hash**, email the **raw**), `purpose` (`'verify'|'reset'`), `expiresAt`, `usedAt`. Generate the raw token as `randomBytes(32).toString("base64url")`.
- On signup: create a `verify` token (24 h expiry), email `https://host/verify?token=…`. `GET/POST /auth/verify`: look up by hash, check not expired/used, set `users.email_verified_at = now`, mark token used. Vague error on bad/expired (`"Invalid or expired link"`) — no enumeration.
- **Gate sensitive actions** (`PUT /credentials`, `PUT /schedule`, `POST /runs`) behind `email_verified_at != null` once this ships, OR allow a grace window — your call, but be explicit. Audit `email_verified`.

### 4B.3 — Password reset
Three endpoints, all generic-messaged:
- `POST /auth/forgot-password {email}` → always `200` (never reveal whether the email exists). If the user exists, create a `reset` token (1 h), email the link. Audit `password_reset_requested`.
- `POST /auth/reset-password {token, newPassword}` → validate token (hash lookup, not expired/used), `min 12` password, `hashPassword`, update, **mark token used**, and **delete all of that user's sessions** (force re-login everywhere). Audit `password_reset_completed`.
- Timing-safe token comparison; tokens are single-use.

### 4B.4 — Idle session timeout (⚑ improvement #4)
In `findValidSession`, in addition to the 30-day absolute expiry, treat a session as expired if `now - lastUsedAt > 7 days` (delete + return null). Keeps the absolute cap *and* adds idle expiry. One extra comparison.

> ⚠️ **As-built (found 2026-08-08, 4B round 2):** two things diverge from this section.
> **(1) A privilege escalation was found and closed.** `consumeResetToken` originally ignored the `purpose` column, so a **verify token could be redeemed at the reset endpoint to change a password** — and verify tokens are minted automatically at signup with a 24 h TTL, while reset tokens are deliberately requested with a 1 h TTL, so the weaker token opened the stronger door. `purpose` is now a required parameter, checked against the stored row, and tested in both directions (verify-at-reset and reset-at-verify), with neither token consumed on a failed attempt.
> **(2) Verification is deliberately NOT enforced.** This section offers gating `PUT /credentials` / `PUT /schedule` / `POST /runs` on `email_verified_at` as "your call". For this build the answer is **no**: with no mail provider configured — the documented default — verification links only ever reach the server log, so gating would make the app unusable for every colleague. Verification is built and displayed; enforcement waits until a real provider is configured.
> **Also:** § 4B.6 (data export) and § 4B.7 (monitoring hooks) were **deliberately skipped** — export is ceremony for a handful of users, and admin visibility is ranked in `BACKLOG.md` where it can be judged against everything else. 4B is functionally complete without them.

### 4B.5 — Account deletion
`DELETE /auth/account` (auth required, re-enter password to confirm): inside a transaction, delete the user (cascades sessions/credentials/schedules/runs), and the `audit_log` rows keep `userId` as `null` (the FK is `SET NULL`) so the trail survives. Write a final `account_deleted` audit entry first. Also `unregisterSchedule(userId)` so the cron tasks stop. Confirm storage-state/screenshot dirs for that UUID are removed from `DATA_DIR`.

### 4B.6 — Data export (GDPR-friendly)
`GET /auth/export` → a JSON download of the user's own non-secret data (profile, schedule, run history, audit entries) — **never** the decrypted credentials or password hash. `Content-Disposition: attachment`.

### 4B.7 — Monitoring hooks (security-adjacent)
Add admin-only (`is_admin`) read endpoints or a log-based alert: N failed logins for one account in M minutes; first login from a new IP per user. Keep `/health` public + minimal; gate any detailed status behind admin auth.

**Gate 4B (per feature you adopt):** verify-link flips `email_verified_at`; reset flow invalidates old sessions (an old cookie 401s after reset); a reset/verify token can't be reused; idle session past 7 days 401s; account deletion cascades (no orphan rows; audit row survives with null user); export contains no secrets.

> **TOTP 2FA** stays deferred to Phase 6 — `otplib` + `qrcode`, gated behind a per-user flag. Don't build it in the rebuild unless explicitly wanted.

Commit each piece as you verify it (see Commit checkpoints above), then tag `git tag phase-4-complete`.
