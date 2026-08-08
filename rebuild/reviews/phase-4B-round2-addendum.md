# Phase 4B round 2 (email verification + account deletion) — review addendum

Scope: **§ 4B.2 and § 4B.5 only.** § 4B.6 (data export) and § 4B.7 (monitoring) were deliberately **not** built — export is ceremony for a handful of users, and admin visibility is already ranked in `BACKLOG.md`. Do not report their absence as a gap.

---

## A. Pre-review structural check (done by the human's session — confirm, don't redo)

- **A real security hole was found and fixed by the implementer, unprompted.** `consumeResetToken` previously ignored `purpose`, so a **verify token could be redeemed at the reset endpoint to change a password**. That is a privilege escalation: verify tokens are minted automatically at signup with a 24-hour TTL, reset tokens are deliberately requested with a 1-hour TTL — the weaker token opened the stronger door. Now `purpose` is a required parameter and `row.purpose !== purpose` returns null (`reset-tokens.ts:62,71`); callers pass `"reset"` (auth.ts:287) and `"verify"` (auth.ts:315). **Verify this is covered by a test in both directions** — verify-token-at-reset and reset-token-at-verify.
- **No migration.** `reset_tokens.purpose` and `users.email_verified_at` already existed, so the phase-7 dev-DB blind spot does not apply this round.
- **Deletion ordering and guards present:** refuses while a run is `pending`/`running` (409), `unregisterSchedule`, `account_deleted` audit carrying only `emailHash`, then cascade delete, then `removeUserData`.
- **`removeUserData` is safely scoped** — it uses the existing `userSessionDir` / `userScreenshotRoot` helpers with a UUID taken from the session, never from the request, with `force: true` so a missing directory is not an error.
- **Gates verified independently:** typecheck ✅ · 87 unit ✅ · 93 integration ✅ · 14 e2e ✅.

## A2. Pre-existing bug found during manual testing — AuthPage unmounted mid-typing (fixed by the human's session)

**Not a round-2 defect** — it dates from phase 3 and only surfaced when someone alt-tabbed away from a half-filled login form.

`["me"]` has no data while logged out (only a 401 error), so any refetch returns it to `pending`, `isLoading` goes true, `AuthGate` renders its loading branch, and **`AuthPage` unmounts, discarding whatever the user had typed**. `refetchOnWindowFocus` defaults to `true` in TanStack Query v5 and was never overridden, so every tab-focus did this. Confirmed from the console: two `GET /auth/me 401` entries (mount + focus refetch) with console history intact, ruling out a browser tab discard.

**Fixed two ways, both deliberate:**
- `useMe` sets `refetchOnWindowFocus: false`. Re-checking the session on tab focus buys little — a dead session 401s on the next real action — and it is a large share of the dev-log noise.
- `AuthGate` guards the loading branch with `isLoading && !isFetched`, so it renders only on the **first** load. `isFetched` stays true once the query has settled even once, so *any* background refetch (focus, reconnect, remount) leaves the current screen mounted. This fixes the class, not just the focus case.

Typecheck clean, 14/14 e2e still pass, and **verified live**: typing into the login form, alt-tabbing away and returning now preserves the text. **Review these two edits as part of the diff — they are not the implementer's work.**

## B. Review focus

1. **The purpose separation is the most important thing in this diff.** Confirm both directions are tested and that no other call site can reach `consumeResetToken` without a purpose.
2. **Verification is deliberately NOT enforced.** Nothing gates on `email_verified_at`, by explicit instruction: with no mail provider (the documented default) links only reach the server log, so gating `PUT /credentials` / `PUT /schedule` / `POST /runs` would make the app unusable for every colleague. **Do not add enforcement**, and do not report its absence as incomplete.
3. **A failed delete can leave a false `account_deleted` audit row.** The audit is written *before* the cascade so the FK `SET NULL` preserves the trail — but if the delete then fails, the log claims an account was deleted that still exists. Consider whether writing the row *after* a successful delete, with `userId: null` set explicitly plus the `emailHash`, is the better ordering: it keeps attribution and only ever claims what actually happened. The implementer's reasoning for the current order is sound; this is a judgement call worth a second opinion, not a defect.
4. **Wrong-password deletion attempts are not audited.** Repeated failures on `DELETE /auth/account` are a meaningful signal — someone holding a stolen session probing to destroy an account. Low priority; note it rather than block on it.
5. **Signup is best-effort about the verify token and email** — the account is created and returns 201 even if token insert or mail fails. Correct (a transient hiccup shouldn't turn a committed signup into a 500), but confirm the user can still recover via resend.
6. **Resend when already verified** returns `200 {ok:true}` with no mail. Confirm it leaks nothing and cannot be used to probe verification state of *another* account.
7. **`/auth/verify` is rate-limited by one prefix mount** covering GET, POST and `/resend`. Confirm from `app.ts` that the prefix genuinely covers all three.
8. **The SPA catch-all** excludes `auth|credentials|schedule|runs|health|notifications` — `/verify` is not in that list, so it correctly falls through to `index.html`. Confirm the emailed link path and the SPA route agree.

## C. Ledger updates required in this commit

- `STATE.md`: move email verification + account deletion to "Built and verified"; record that **4B.6 and 4B.7 were deliberately skipped**, so 4B is functionally complete rather than partially done.
- Dated as-built note on `phase-4-security.md` § 4B for the purpose-separation fix and the not-enforced decision.
- **Commit this addendum file** — the phase-7 and 4B-round-1 addenda were both missed on their first commit.
- Tagging: 4B is now complete except the two deliberate skips. Leave the tag to the human.

## D. `[manual]` check results (human-run)

| # | Check | Result |
|---|---|---|
| 1 | Sign up → the verification link appears in the backend log; clicking it verifies the account | ✅ `email_verified_at` set. The screen requires an explicit **Verify email** click rather than verifying on load — correct, since mail scanners pre-fetch links and a GET that mutates state can be consumed before the human clicks. On success the token is stripped from the URL via `history.replaceState`, matching the reset flow |
| 2 | The dashboard shows the unverified banner, and it disappears after verifying | ✅ banner shown: "Email not verified — Check your inbox for the verification link we sent you" + Resend action. (Disappearance confirmed under check 1.) |
| 3 | Resend produces a new working link; the older one still works until used | ✅ resend returned `200 {"ok":true}` and logged a fresh link; `reset_tokens` then held **two unused verify rows** for that user (signup + resend), confirming a resend does not invalidate the earlier token. After verifying with the resend token, the DB showed the resend row `used=t` and the **original signup row still unused** — proven, not assumed |
| 4 | A verify token is **rejected** at the reset endpoint (the escalation that was fixed) | ✅ `400 {"error":"Invalid or expired token"}` — an unused 24 h verify token could not be spent at the 1 h reset endpoint. Before this round it would have set the password |
| 5 | Account deletion with the wrong password → 401 | ✅ `401 {"error":"Incorrect password"}` |
| 6 | Deletion is refused (409) while a run is pending/running | ✅ `409` with an actionable message: "Cannot delete your account while a run is in progress. Wait for it to finish, then try again." |
| 7 | After deletion: no rows in users/credentials/schedules/runs/sessions/notification_settings, and `data/sessions/<uuid>` + `data/screenshots/<uuid>` are gone | ✅ `200 {"ok":true}` with the `sid` cookie expired to 1970. Zero rows across **all eight** user-referencing tables (users, sessions, credentials, schedules, runs, reset_tokens, notification_settings, missed_run_notices). Both data directories removed — they were **seeded with files first**, so this proves removal rather than a no-op on absent paths |
| 8 | The `account_deleted` audit row survives with `user_id` null and a usable `emailHash` | ✅ `user_id` NULL via the `SET NULL` FK, metadata `{"emailHash": "5776a6a6c0324060"}` and nothing else — the trail outlives the account without storing the address |
| 9 | Banner layout at 375px | ✅ iPhone SE (375×667): text wraps, the Resend button drops below it, nothing clipped, page does not scroll horizontally |
