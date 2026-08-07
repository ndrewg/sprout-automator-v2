# Phase 4A.2 (signup gating) — review addendum

Hand to the reviewer alongside the implementer's Handoff report, or point it at this file.

---

## A. Pre-review structural check (done by the human's session — confirm, don't redo)

- **No test-mode bypass in the guard.** Grepped `signup-allowlist.ts` and `routes/auth.ts` for `NODE_ENV` / test-conditional logic — nothing. The check is unconditional, which was the main risk in this sub-phase: the tempting fix for the broken suite was a `NODE_ENV === "test"` escape hatch that would leave the guard permanently unexercised in the one place it is enforced.
- **The suite was fixed via environment, not by weakening the route.** `vitest.config.ts` and `vitest.workspace.ts` set `SIGNUP_ALLOWED: "Example.com, maz.getutua@gmail.com"`; `e2e-server.mjs` sets `"example.com"` with an explanatory comment. The capital `E` in the vitest value means every integration signup implicitly exercises case-insensitive matching.
- **No migration generated**, as required — 4A.2 touches no schema.
- `rebuild/reviews/phase-7-addendum.md` was left untracked when phase 7 was committed. **Include it in this commit** so the review record is complete.

## B. Review focus

1. **The generic rejection must not leak the allowlist.** Same message and status for "wrong domain", "not on the list", and (if applicable) "signup disabled". A distinguishable response turns the endpoint into an oracle for which domains are valid.
2. **`signup_rejected` audit metadata must carry only a non-reversible `emailHash`** — never the attempted address, never the allowlist contents. Same pattern as `login_failure`.
3. **`authLimiter` still applies to `/auth/signup`.** Without it the allowlist is brute-forceable. Confirm from `app.ts`, not from intent.
4. **Production refuses to boot with `SIGNUP_ALLOWED` unset or empty**, while development allows all with a warning. Verify the production branch actually fails rather than falling through to permissive.
5. **Parsing edge cases**, each with a test that can fail: surrounding whitespace, empty entries from a trailing comma, mixed case on both sides, an entry that is bare `@`, and a domain entry that must not match a *substring* (`notorchard.com.au` must not pass against `orchard.com.au`).
6. **Login is untouched.** The allowlist gates new signups only; existing accounts keep working. Confirm no check was added to the login path.
7. Confirm the affected-test count in the Handoff report matches what the diff actually changed.

## C. Ledger updates required in this commit

- `STATE.md`: move signup gating from "Not built" to "Built and verified"; update "Suggested order from here" so 4B is next.
- Add a dated as-built note to `phase-4-security.md` § 4A.2 if reality diverged.
- Commit the untracked `rebuild/reviews/phase-7-addendum.md`.
- **Do not create a tag.**

## D. `[manual]` check results (human-run)

| # | Check | Result |
|---|---|---|
| 1 | Signup with an allowed domain address → succeeds | ✅ `testuser@orchard.com.au` → `201` + `Set-Cookie` |
| 2 | Signup with a disallowed address → rejected, generic message | ✅ `403 {"error":"Signup is not open."}` — names neither the allowlist nor the reason. Headers also confirmed `RateLimit-Policy: 10;w=900` on `/auth/signup` (review item 3) and that a *rejected* attempt still decrements the budget, so the allowlist cannot be probed for free |
| 2b | Substring attack: `attacker@notorchard.com.au` must **not** match `orchard.com.au` | ✅ `403` — proper boundary match, not a suffix check |
| 3 | Case-insensitive: `Test2@ORCHARD.com.au` → succeeds | ✅ `201`, and the response returned `test2@orchard.com.au` — normalisation happens before storage, not just before comparison |
| 4 | Existing account still logs in normally | ✅ tested properly by removing the operator's gmail from `SIGNUP_ALLOWED` first — that address could no longer *sign up*, but still logged in. Confirms grandfathering: the check did not leak into the login path |
| 5 | `audit_log` shows `signup_rejected` with no email or allowlist value in it | ✅ rows contain only `{"emailHash": "…"}` — no address, no allowlist contents |
| 6 | Production mode with empty `SIGNUP_ALLOWED` refuses to start | ✅ exits via `config.ts` with `Invalid environment configuration: SIGNUP_ALLOWED: required when NODE_ENV=production — set a comma-separated list of allowed email addresses and domains`. Message names the fix, not just the failure. Restored to development afterwards and login re-verified |
