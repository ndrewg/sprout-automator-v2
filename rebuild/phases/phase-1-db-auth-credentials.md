# Phase 1 — Database, Auth & Encrypted Credentials

**Goal:** Postgres schema + migrations; signup/login/logout/me with Argon2id + DB-backed signed-cookie sessions; per-user AES-256-GCM credential storage with the partial-update contract. This is the security spine — build it exactly.

**Attach for this session:** `03-CONVENTIONS-AND-GUARDRAILS.md`, `reference/database-schema.md`, `reference/crypto-and-otp-specs.md`, `reference/api-contract.md`.

**Build in three sub-steps, each with its own gate.** Feed them one at a time if the model strains.

> **Commit checkpoints** — commit only when a gate is green; never a red gate; *you* run the commit, not the agent. Suggested messages:
> - Gate 1A → `feat(phase-1): postgres schema + drizzle migrations [gate 1A]`
> - Gate 1B → `feat(phase-1): argon2 + DB-backed signed-cookie sessions [gate 1B]`
> - Gate 1C → `feat(phase-1): AES-256-GCM credential storage [gate 1C]`
> Then tag: `git tag phase-1-complete`.

---

## 1A — Database

1. Create `src/db/schema.ts`, `src/db/client.ts`, `src/db/migrate.ts` — **verbatim from `reference/database-schema.md`.**
2. Generate the initial migration:
   ```bash
   cd app/backend && npm run db:generate -- --name init
   ```
   Open the generated SQL in `app/backend/drizzle/` and **confirm** it contains:
   - `users_email_unique` on `lower(email)`
   - `runs_one_active_per_user` as a **partial** unique index with `WHERE status IN ('pending','running')`
   - the `ON DELETE CASCADE` / `SET NULL` FKs as specified
3. Apply it: `npm run db:migrate` → `[migrate] done`.
4. Wire the real DB health check into `index.ts`: `await db.execute(sql\`select 1\`)` in a try/catch → `db:"ok"|"down"`.

**Gate 1A:** `npm run db:migrate` succeeds; `/health` returns `db:"ok"`; the partial index exists (`docker compose exec postgres psql -U sprout -d sprout -c '\d runs'` shows the partial unique index).

---

## 1B — Auth

Create:
- `src/lib/passwords.ts` — verbatim from `reference/crypto-and-otp-specs.md` (Argon2id).
- `src/lib/sessions.ts` — `createSession`, `findValidSession` (deletes & returns null if expired; bumps `last_used_at` best-effort), `deleteSession`, `purgeExpiredSessions`. 30-day absolute TTL.
- `src/lib/cookies.ts` — `sid` cookie helpers. `setSessionCookie`: `httpOnly`, `sameSite:"strict"`, `secure: NODE_ENV==="production"`, `signed:true`, `maxAge` 30d, `path:"/"`. `readSessionCookie` reads `req.signedCookies["sid"]`. `clearSessionCookie`.
- `src/lib/audit.ts` — `recordAudit(eventType, ctx)` inserting into `audit_log`. Event union per `reference/database-schema.md`.
- `src/middleware/auth.ts` — `attachUser` (reads cookie → `findValidSession` → loads user → sets `req.user`/`req.sessionId`; augments Express `Request` via `declare module`), and `requireAuth` (401 if no `req.user`).
- `src/routes/auth.ts` — `/signup`, `/login`, `/logout`, `/me` per `reference/api-contract.md`.

Wire into `index.ts` (in this order): `cookieParser(config.SESSION_SECRET)` after `express.json`, then `attachUser`, then mount `authRouter` at `/auth`.

**Critical auth rules (from the contract):**
- Signup/login validate with a `.strict()` Zod schema: `email` (email, ≤254), `password` (12–200). Email is `.toLowerCase().trim()`-ed.
- Login looks up via `sql\`lower(${users.email}) = ${email}\``.
- **Timing equalization:** if no user, still `verifyPassword` against the dummy hash (see crypto reference) before returning the generic 401.
- Same `"Invalid email or password"` for both failure modes.
- Audit `signup`/`login_success`/`login_failure`/`logout`. Login-failure metadata carries a non-reversible `emailHash` (small hash fn), never the email.
- Signup catches Postgres `23505` → `409 "Email already registered"`.
- `publicUser(u)` returns only `{ id, email, isAdmin }` — never the hash.

**Gate 1B:** with `curl -c jar -b jar`:
1. `POST /auth/signup` (valid) → 201 + `Set-Cookie: sid=...; HttpOnly`. Re-signup same email → 409.
2. `GET /auth/me` with the cookie → 200 user; without → 401.
3. `POST /auth/login` wrong password → 401 `"Invalid email or password"`; nonexistent email → same 401 (and noticeably not instant — the dummy verify ran).
4. `POST /auth/logout` → 200; subsequent `/auth/me` → 401.
5. `select event_type from audit_log` shows the events.

---

## 1C — Encrypted credentials

Create:
- `src/lib/encryption.ts` — verbatim from `reference/crypto-and-otp-specs.md`. **This is the only module that touches `*_enc` columns.**
- `src/routes/credentials.ts` — `GET` / `PUT` / `POST /test-imap` / `DELETE` per the contract. (Note: `test-imap` depends on `src/lib/imap-otp.ts`, which is built in Phase 2. For Phase 1, either stub `test-imap` to `501` or pull `imap-otp.ts` forward now — pulling it forward is cleaner; it's a leaf module with no Phase-1 deps. If you pull it forward, copy it verbatim from the crypto/OTP reference.)

Mount `credentialsRouter` at `/credentials` (after `attachUser`); the router does `router.use(requireAuth)`.

**Critical credential rules:**
- `PUT` body is a `.strict()` partial: `sproutUsername?/sproutPassword?/gmailEmail?/gmailAppPassword?`, each `string(1–200)|null` (`gmailEmail` is `.email()` ≤254). **omitted=unchanged, string=encrypt&set, null=clear.** Reject empty body → `400 "No fields to update"`.
- Upsert: update if a row exists, else insert (with `userId`).
- `toView(row)` returns `CredentialView` — decrypt the two non-secret fields for display, expose passwords only as `*Set` booleans. **Never** return a decrypted password.
- Audit `credentials_updated` with `metadata.fields = changedFieldNames`. *(⚑ RECOMMENDED #6: use `credentials_deleted` for DELETE.)*

> ⚑ RECOMMENDED (improvement #2): add `vitest` and write the encryption tests from `reference/crypto-and-otp-specs.md` now. They take five minutes and catch the subtle byte-layout mistakes a local model makes.

**Gate 1C:**
1. `PUT /credentials {"sproutUsername":"u","sproutPassword":"p"}` → 200; `GET` shows `sproutUsername:"u"`, `sproutPasswordSet:true`, no plaintext password anywhere.
2. `PUT /credentials {"sproutPassword":null}` → `sproutPasswordSet:false`. `PUT {}` → 400.
3. In psql, `select sprout_password_enc from credentials` is opaque base64url — **not** the plaintext.
4. Restart the backend; `GET /credentials` still decrypts the username correctly (proves the key/format round-trips across restarts).

If 1A + 1B + 1C gates pass, Phase 1 is done — three gate commits should already be in history (see Commit checkpoints above). Tag it: `git tag phase-1-complete`.
