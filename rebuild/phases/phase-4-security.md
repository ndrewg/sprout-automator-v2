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
Pick a transactional email provider; **Resend** is the least-friction (`resend` npm SDK, one API key). Add `RESEND_API_KEY` + `MAIL_FROM` to `config.ts` (optional in dev — if unset, log the email to console instead of sending, so dev doesn't need a provider). Create `src/lib/mailer.ts` with `sendMail({to,subject,html})`; **never** put secrets/tokens-in-plaintext-logs through it. All token *values* go only in the emailed link, never in audit metadata.

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

### 4B.5 — Account deletion
`DELETE /auth/account` (auth required, re-enter password to confirm): inside a transaction, delete the user (cascades sessions/credentials/schedules/runs), and the `audit_log` rows keep `userId` as `null` (the FK is `SET NULL`) so the trail survives. Write a final `account_deleted` audit entry first. Also `unregisterSchedule(userId)` so the cron tasks stop. Confirm storage-state/screenshot dirs for that UUID are removed from `DATA_DIR`.

### 4B.6 — Data export (GDPR-friendly)
`GET /auth/export` → a JSON download of the user's own non-secret data (profile, schedule, run history, audit entries) — **never** the decrypted credentials or password hash. `Content-Disposition: attachment`.

### 4B.7 — Monitoring hooks (security-adjacent)
Add admin-only (`is_admin`) read endpoints or a log-based alert: N failed logins for one account in M minutes; first login from a new IP per user. Keep `/health` public + minimal; gate any detailed status behind admin auth.

**Gate 4B (per feature you adopt):** verify-link flips `email_verified_at`; reset flow invalidates old sessions (an old cookie 401s after reset); a reset/verify token can't be reused; idle session past 7 days 401s; account deletion cascades (no orphan rows; audit row survives with null user); export contains no secrets.

> **TOTP 2FA** stays deferred to Phase 6 — `otplib` + `qrcode`, gated behind a per-user flag. Don't build it in the rebuild unless explicitly wanted.

Commit each piece as you verify it (see Commit checkpoints above), then tag `git tag phase-4-complete`.
