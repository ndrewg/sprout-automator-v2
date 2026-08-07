# Phase 4B round 1 (mailer + password reset + idle timeout) — review addendum

Scope of this round: **§ 4B.1, § 4B.3, § 4B.4 only.** 4B.2 (email verification), 4B.5 (account deletion), 4B.6 (export) and 4B.7 (monitoring) are a later round — do not report their absence as a gap.

---

## A. Pre-review structural check (done by the human's session — confirm, don't redo)

- **No new dependencies.** No `react-router` (the reset screen reads `location.search` in the existing components) and no `resend` SDK. Both were explicit constraints.
- **Migration `0003_reset_tokens.sql` was applied to the dev database** — `reset_tokens` exists in `sprout`, not only in `sprout_test`. This is the trap that broke phase 7 (every gate green, `pnpm dev` unable to boot); it was handled this time.
- **Session invalidation on reset is correct:** `db.delete(sessions).where(eq(sessions.userId, userId))` removes *every* session for that user, not just the requesting one. This is the property that makes a reset meaningful.
- **Idle timeout:** `SESSION_IDLE_TTL_MS = 7 days` checked against `lastUsedAt` in `findValidSession`, alongside the existing 30-day absolute expiry.
- **Tokens are stored hashed** (SHA-256 of a 32-byte random value) and looked up *by hash*. There is deliberately no `timingSafeEqual`: an indexed lookup on a hash has no secret-dependent branch in application code, which satisfies the spec's "timing-safe comparison" intent more cleanly than a string compare would. Do not "fix" this by adding one.

## A2. BLOCKING defect — the reset flow cannot be completed without a mail provider

**Cause is a spec error in the round-1 prompt, not implementer error.** The prompt said the dev logging path must "never log the email body or any token". The implementer followed it exactly (`lib/mailer.ts:29-33` logs `to` + `subject` only). The consequence: with no provider configured, the reset link is never sent *and* never logged, and the database stores only the token's SHA-256 hash — so **there is no way to obtain the token and no way to reset a password.** The feature is unusable in dev and on any self-hosted install without Resend, which is the documented default posture.

The "no token in logs" rule is correct for **production** and wrong for the **fallback**: making the link reachable is the entire purpose of the fallback.

**Fix — make the branch depend on the environment, not just on provider presence:**
- **No provider AND `NODE_ENV !== "production"`** → log the full message including the link, at `info`. This is a developer convenience path and the link is the point.
- **No provider AND `NODE_ENV === "production"`** → log recipient + subject only (as now), plus a loud `warn` that password-reset emails cannot be delivered until `RESEND_API_KEY` and `MAIL_FROM` are set. Do **not** refuse to start — a self-hosted operator without mail should still get a working app, just without reset.
- Provider configured → unchanged; never log the body.

Add unit tests for all three branches: dev-no-provider logs the body, prod-no-provider does not, provider-configured does not.

> ✅ **FIXED.** All three branches implemented and tested (`mailer-log`, `mailer-prod-no-provider`, `mailer-send`); the production test asserts `html` is absent from both the `info` and `warn` payloads. `phase-4-security.md` § 4B.1 corrected.

Also correct `phase-4-security.md` § 4B.1, which is ambiguous on this point and produced the error.

## A3. BLOCKING defect — a reset link is ignored while a session exists

Found during `[manual]` testing. `AuthGate.tsx` is:

```tsx
return user ? <Dashboard user={user} /> : <AuthPage />;
```

The reset token in `location.search` is never consulted, so **a logged-in user who opens the reset link gets the dashboard and the reset form is unreachable.** That is the normal case, not an edge case: clicking a reset link from email while a session is still alive on that browser is exactly how people use these. The symptom is silent — the page loads, nothing is wrong on screen, and the reset simply cannot be performed. Same shape as the phase-T `qc.clear()` logout bug.

**Fix:** check for a reset token *before* the auth branch, and render the reset screen regardless of session state:

```tsx
const token = new URLSearchParams(window.location.search).get("token");
if (token && window.location.pathname === "/reset") return <ResetPage token={token} />;
return user ? <Dashboard user={user} /> : <AuthPage />;
```

Gate the path as well as the param so an unrelated `?token=` elsewhere cannot hijack rendering. Resetting while logged in is coherent — the reset deletes every session for that user, so they end up logged out anyway. After a successful reset, clear the query string (`history.replaceState`) so a refresh does not re-submit a spent token.

Add an e2e case covering **reset while authenticated**, since the existing `reset.spec.ts` presumably only covers the logged-out path — that gap is why this shipped.

> ✅ **FIXED.** `AuthGate` now reads the token via a `/reset`-pathname-gated helper and renders `ResetPasswordPage` before the auth branch. The token is held in `useState` rather than re-read each render, so `history.replaceState` can strip it from the URL after success without unmounting the screen mid-flow — a naive version would blank the confirmation the moment the URL changed. E2E case added: "reset while authenticated: the reset screen renders instead of the dashboard".

## A4. Config note — `APP_URL` is wrong for the dev loop

`config.ts` defaults `APP_URL` to `http://localhost:3000`, correct for the single-origin Docker build where Express serves the SPA. But in the dev loop the SPA is on **`:5173`** and `:3000` serves whatever stale bundle is sitting in `app/backend/public`. The emailed link therefore points at the wrong origin during development.

Not a code defect — but `RUNNING.md` and the `.env.example` comment should state that the dev loop wants `APP_URL=http://localhost:5173`, or the first person to test a reset locally loses time to it exactly as happened here.

> ✅ **FIXED (docs).** Noted in `.env.example` and RUNNING.md's dev-loop section.

## A5. BLOCKING — reset endpoints were not rate-limited; fixing it exposed two further problems

**Haiku's finding, confirmed:** `app.ts` mounted `authLimiter` on `/auth/login` and `/auth/signup` only. `/auth/forgot-password` (which **sends email** — a mailbox-flooding and account-probing surface) and `/auth/reset-password` (which accepts an **unauthenticated token**) had no limit at all. Both are now mounted. Note token validation precedes `hashPassword`, so an invalid token costs a DB lookup rather than an Argon2 hash — the DoS angle is weaker than it looks, but these are unauthenticated endpoints in the same family as login and belong behind the same guard.

**Problem 1 — the fix breaks five tests, and a test-mode bypass is NOT the answer.** `authLimiter` is a single instance whose store is shared across every mount point, keyed by IP at 10/15min. `password-reset.test.ts` legitimately issues more than ten requests, so it now starves itself (`expected 429 to be 200`). The integration project runs single-fork, so the store persists across files too.
**Fix:** give the harness a way to clear the limiter store between tests, exactly as it truncates the database — construct the `MemoryStore` explicitly in `middleware/security.ts`, export a `resetRateLimits()`, and call it from the harness's per-test reset. **Do not** add a `NODE_ENV === "test"` bypass: that would leave the guard unexercised in the one place it is enforced, which is the mistake 4A.2 deliberately avoided.

**Problem 2 — IP-keyed limits and shared NAT (pre-existing, now tighter).** The limiter keys on IP, so **every colleague behind one corporate NAT shares a single 10-per-15-minute budget** across login, signup, forgot-password and reset. Several people fumbling passwords the same morning would lock out the rest, and the symptom ("it says too many attempts and I haven't tried once") is baffling from the user's side. Already true for login+signup; two more endpoints makes it likelier to bite.
**Options, for a deliberate decision rather than a default:** raise the budget; key login/reset attempts by *email* with a separate looser IP-keyed backstop; or give the reset endpoints their own limiter so a reset flow cannot consume the login budget. → Record in `BACKLOG.md` if not fixed now.

## B. Review focus

1. **The mailer's logging is environment-dependent by design — see A2. Do not "fix" the dev branch.** Non-production with no provider logs the **full body including the link** (that is the only way to complete a reset locally); production with no provider logs recipient + subject only, plus a warn; a configured provider never logs the body. All three branches have unit tests. What to check: that the production branch genuinely cannot emit the body, and that `lib/logger.ts`'s redact list did not accidentally strip the dev body (which would silently re-break A2).
2. **`POST /auth/forgot-password` must return 200 identically** for an existing and a nonexistent address — same status, same body, and ideally no large timing difference. Any divergence turns it into an account-existence oracle. Check there is no early return that skips work for the unknown-account case in a way a timer could detect.
3. **Single-use enforcement.** `usedAt` must be set in the same operation that accepts the token, not after the password update — otherwise two concurrent requests with the same token could both succeed. Look for whether the update is conditional on `usedAt IS NULL`.
4. **Expiry is checked as well as use.** A token past 1 hour must be rejected even if unused.
5. **The new password goes through Argon2id** via `lib/passwords.ts`, with the same `min 12` Zod rule as signup. No separate hashing path.
6. **Generic errors on the reset endpoint too** — "Invalid or expired link" for bad, expired and already-used tokens alike, so the endpoint does not distinguish them.
7. **Audit metadata carries no token value** for `password_reset_requested` / `password_reset_completed`, and both were added to the `AuditEventType` closed union.
8. **Rate limiting:** `authLimiter` should cover `/auth/forgot-password` — without it, the endpoint is a free email-sending and account-probing tool. Confirm from `app.ts`.
9. **Frontend:** the reset form reads the token from `location.search`, and `save`-style handlers use `await mutateAsync` inside `try/catch` (the ⭐ rule). No token should be placed in component state longer than needed, and none in `localStorage`.

## C. Ledger updates required in this commit

- `STATE.md`: add password reset + idle session timeout to "Built and verified"; keep 4B.2/4B.5/4B.6 in "Not built" and note that 4B was split, with round 2 remaining.
- Dated as-built note on `phase-4-security.md` § 4B if reality diverged.
- **Do not create a tag** — 4B is incomplete until round 2.

## D. `[manual]` check results (human-run)

| # | Check | Result |
|---|---|---|
| 1 | `forgot-password` for a real account → 200, and the reset link appears in the backend log (dev mailer) | ✅ `200 {"ok":true}`; the dev mailer logged `to`, `subject` and the full `html` with the `/reset?token=…` link |
| 2 | `forgot-password` for an address with no account → **identical** 200 response | ✅ byte-identical — both responses carried the *same* `ETag: W/"b-Ai2R8hgEarLmHKwesT1qcY913ys"`, so no account-existence oracle |
| 3 | The link sets a new password successfully | ✅ via the browser reset screen (reads the token from `location.search`; no router added) |
| 4 | Every pre-existing session for that user is dead afterwards (old cookie 401s) | ✅ the pre-reset cookie → `401 {"error":"Not authenticated"}`. A stolen cookie dies with the reset |
| 5 | The same token cannot be used twice | ✅ second submit → *"Reset failed — Invalid or expired token"*. Generic: does not distinguish used / expired / unknown. Backend claim is atomic (`UPDATE … WHERE id = ? AND used_at IS NULL RETURNING id`) so concurrent submits cannot both win |
| 6 | Login with the new password works | ✅ `200` + fresh `Set-Cookie` (`HttpOnly; SameSite=Strict`) |
| 7 | A session idle past 7 days is rejected (forced via DB); one inside the window still works | ✅ aged `last_used_at` by 8 days → `401`. The same cookie worked immediately before, so the rejection is the idle rule and not the absolute expiry |
| 9 | A3 re-verified live: **logged in**, opened `/reset?token=…` on `:5173` → the reset form rendered, not the dashboard | ✅ |
| 8 | `pnpm dev` boots after the migration (phase-7 regression guard) | ✅ `reset_tokens` present in the dev `sprout` database and the backend served the whole manual run |
