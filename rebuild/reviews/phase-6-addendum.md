# Phase 6 — review addendum

Hand this to the reviewer alongside the implementer's Handoff report (or just point it at this file). Accumulated during `[manual]` testing on 2026-08-07.

---

## A. Fixes already applied by the human's session (review these too — they are not the implementer's work)

1. **Vite dev proxy was missing `/notifications`** (`app/frontend/vite.config.ts`). Every request from the dev loop 404'd at Vite and never reached the backend; the frontend then tried to `JSON.parse` an HTML error page. The backend was fully correct — router mounted, `apiLimiter` applied, SPA catch-all regex already excluded `notifications`.
   **Nothing could have caught this:** integration tests call the backend directly on an ephemeral port, and e2e runs against the single-origin built SPA. The dev proxy is the one path with no coverage.
   → Add to the phase docs: **a new top-level API prefix requires four registrations** — Vite proxy, `apiLimiter`, router mount, SPA catch-all regex. The implementer got three of four.

2. **Setup walkthrough had a dead link** (`NotificationsPanel.tsx`). The `getUpdates` anchor's `href` contained a literal `<TOKEN>`, so clicking it navigated to `api.telegram.org/bot<TOKEN>/getUpdates` and returned a 404 — confirmed against the live API. Now rendered as non-clickable copy text, with **@userinfobot as the primary chat-ID route** so the bot token never enters a URL, address bar, or browser history. The 404 case is explained inline.
   → Verify the Alert still renders correctly at 375px and uses semantic tokens only (no raw colors).

## B. Outstanding defect — not yet fixed

3. **ANSI escape codes leak into user-facing output.** Playwright error strings contain `[2m` … `[22m`, which render as `⊠[2m` boxes in both the Telegram message and the RunsPanel timeline. `escapeHtml` handles `<`/`&` but not ANSI.
   **Fix:** strip ANSI when writing `runs.error` in `finalizeRun` (so the UI, logs, and notification all benefit) — `/\[[0-9;]*m/g`. Additionally truncate to ~300 chars **in the notification only**: a phone notification carrying a multi-line Playwright call log is unreadable, while the full error stays useful in the run row for forensics.

12. **BLOCKING — the skip reason is always wrong.** Confirmed by `[manual]` test: a skipped run notified *"Closing browser context."* instead of the skip reason.
    **Cause is a spec error, not an implementation error.** `phase-6-notifications.md` told the notifier to read the run's **last step**, but `runAutomation`'s `finally` block always logs `"Closing browser context."` last, so `steps.at(-1)` can never be the reason. (Failures were unaffected — they render `runs.error`, not the step.)
    **Consequence:** the ℹ️-vs-⚠️ distinction is dead. "Already clocked, all good" and "could not verify — you may NOT be clocked in" render identically, which removes the entire justification for notifying on `skipped`.
    **Fix (structural, not a heuristic scan of `steps`):**
    - `isAlreadyClockedForToday` returns `{ skipped: boolean; reason: string }` instead of `boolean`. **Fail-safe semantics unchanged** — every path returning `true` today returns `{ skipped: true, reason }`. Selectors, the 1920×1080 viewport, and skip-on-doubt are untouched; this is not "tidying `clock.ts`".
    - `runAutomation` surfaces it on `AutomationResult` as `skipReason`.
    - `finalizeRun` passes `skipReason` to `notifyRunFinished` in place of `lastStep`.
    - The ⚠️ variant keys off `/safety measure|Could not/` in the reason, as originally specified.
    - Add a unit test asserting both skip variants render distinctly, and that neither renders a trailing-lifecycle string.
    → Also correct `phase-6-notifications.md` § "Why `skipped` matters", which currently prescribes the broken last-step approach.

---

## B2. Fix round applied 2026-08-07 — verify these, do not re-report them

**Four fix rounds ran after the original handoff.** Defects **12, 3, 17, 18, 19** are all fixed — verify them, do not re-report them as outstanding. Final gates: **typecheck ✅ · 57 unit ✅ · 37 integration ✅**. Test count grew 42 → 57 unit and 35 → 37 integration across the rounds, all in `telegram.test.ts`, `notifications.test.ts`, `text.test.ts`, and `notification-test-route-retry.test.ts`.

Round-by-round: **12** structural skip reason (`clock.ts` return type) · **3** ANSI stripping + truncation · **17** send retry, 15s timeout, log-noise fix · **18** retry `unknown`, `getBotInfo` parity, `retry_after` cap · **19** interactive test path capped at 2 attempts.

Review the fixes:

13. **HIGHEST-STAKES ITEM IN THIS PHASE — `clock.ts` changed.** `isAlreadyClockedForToday` now returns `{ skipped, reason }` instead of `boolean`. This is the fail-safe already-clocked guard, and the playbook's invariant #5 says it must return "skip" on *any* doubt.
    **Check every single return path**, especially the `catch (err: unknown)` block and the "Attendance card not visible" branch: each one that previously returned `true` must now return `{ skipped: true, … }`. A path that regressed to `{ skipped: false }` would make the system **double-clock** — the exact outcome the guard exists to prevent, and it would only surface as a payroll problem days later. Also confirm selectors, the 1920×1080 viewport, and the date-candidate matching are byte-identical to before.
14. Confirm `finalizeRun` no longer references `updated.steps.at(-1)` anywhere, and that `skipReason` is excluded from the DB `SET` (it is not a column).
15. Confirm ANSI stripping happens **before** the `/safety measure|Could not/` marker test — an ANSI-wrapped `Could not` must still key the ⚠️ variant. The implementer says it does; verify.
16. The implementer also updated `STATE.md`, `BACKLOG.md`, and the phase file this round. That overlaps your job — **verify those edits as part of the diff**, they are not pre-approved. They look honest (no tag claimed, `[manual]` checks listed as outstanding), but check every claim against the code.

17. **Notifications can be silently lost — no retry.** Observed 2026-08-07: two identical failure runs 44s apart, only the second notified. `sendTelegramMessage` uses `AbortSignal.timeout(10_000)` and any transport error returns `{ok:false,error:"network"}`, which `dispatch` logs and drops. That is within spec (a network blip must not increment `blockedCount` or affect the run), but there is **no retry**, so a message can vanish.
    **Why it matters more than it looks:** phase 6's premise is "silence means it worked". A dropped message makes silence ambiguous again. It is worst for the **missed-run** alert, where the `missed_run_notices` row is inserted *before* sending — so a failed send is never retried on the next sweep, and the user is never told.
    **Suggested fix (not blocking the commit):** 2–3 attempts with short backoff for `network` and `rate_limited` only (never for `blocked` or `bad_token`); honour Telegram's `retry_after` on 429. For the missed sweep specifically, consider inserting the notice row only *after* a successful send, or adding a `notified_at` column so a failed send can be retried once on the following sweep without risking a duplicate.
    **ROOT CAUSE CONFIRMED (2026-08-07):** run finished `18:00:44`, `telegram send failed` at `18:00:54` — exactly 10s, i.e. `AbortSignal.timeout(10_000)` fired. `TimeoutError: The operation was aborted due to timeout`. The first outbound HTTPS call after a backend restart pays DNS + TLS handshake; the retry 44s later reused a warm connection and succeeded instantly. **This will recur on every restart and after any idle period — including 05:30, when the host has been quiet all night and the notification matters most.**
    **Fix:** retry `sendTelegramMessage` up to 3 attempts with backoff (~1s, ~3s) for `network`/timeout and `rate_limited` **only** — never for `blocked` or `bad_token`, which are permanent and would waste the auto-disable signal. Honour Telegram's `retry_after` on 429. Raise the per-attempt timeout to ~15s. Keep the whole thing inside the existing fire-and-forget boundary so a run is still never delayed.
    **Also:** the log line dumps an entire `DOMException` including all 25 DOM error constants. Serialize `err.name` + `err.message` only — that noise will bury real signal in production logs.

18. **Follow-ups from the defect-17 retry round** (implemented 2026-08-07; retry for `network`/`rate_limited`, 15s timeout, `retry_after`, log-noise fix — all verified by 6 new unit tests). Three residual items, from the implementer's own flagged assumptions:
    - **`unknown` is not retried.** The task wording said "`network` and `rate_limited` only" and was followed literally — but `unknown` is returned when the response **doesn't parse as JSON**, which is exactly what a Telegram 502/503 HTML error page produces. That is transient and should be retried. Counter-argument: `sendMessage` is not idempotent, so retrying an unknown outcome risks a duplicate message — but the same is true of a timeout, which *is* retried, so the treatment is currently inconsistent. Given the phase's premise ("silence means it worked"), prefer a rare duplicate over a rare silence: **retry `unknown` too.**
    - **`getBotInfo` still has a 5s timeout** while `sendMessage` now has 15s + retries. `getBotInfo` runs on **Test connection** — the first thing a new user clicks, frequently right after a restart, i.e. maximally exposed to the cold-start DNS/TLS latency that caused defect 17. An observed test call already took **5.74s**, brushing the ceiling. A spurious "Failed to connect to Telegram" on someone's first attempt is a bad first impression with no way to tell it is transient. Raise to 15s and give it the same retry treatment.
    - **`retry_after` is honoured uncapped.** Telegram can return hundreds of seconds. Cap at ~60s and give up beyond it rather than holding a pending timer.
    - Accepted as-is: the missed sweep's insert-before-send order stays. The retry makes a lost send rare; the real fix is a `notified_at` column so a failed send can be retried on the next sweep without risking a duplicate. → `BACKLOG.md`.

19. **The retry policy is right for background dispatch and wrong for the interactive test button.** After defect 18's round, `POST /notifications/test` calls `getBotInfo` (3 × 15s ≈ 45s worst case) and then `sendTelegramMessage` (another ≈45s) — so a genuine failure can leave the button showing "Testing…" for **~90 seconds**, against ~15s before. Background dispatch *should* be patient (nobody is waiting; a lost notification is the failure we are preventing). An interactive request should fail fast (a human is watching and can click again).
    **Fix (one line — retry config is already injectable):** the test route passes `{ maxAttempts: 2 }` (or 1) to both calls; background dispatch keeps the default 3. Consider a short "still trying…" state in the panel if it stays above ~10s.
    ✅ **Fixed.** `TEST_RETRY = { maxAttempts: 2 }` at the route call sites only; transport defaults and background dispatch untouched. Worst case ~30s. The implementer verified that 2 attempts + ~1s backoff still fits inside the 10s window, so the existing "second test within 10s → 429" rate-limit test remains meaningful rather than being silently invalidated.

20. **Missed-run message hardcodes the clock-in wording.** Observed 2026-08-07: a clock-**out** miss rendered *"Clock **in** manually if you haven't already."* The heading and expected time are correctly action-aware; only the closing instruction — the one actionable sentence in the message — is not. Wrong on half of all missed alerts, and actively confusing in the evening.
    **Fix:** derive it from the action, e.g. `Clock ${action === "in" ? "in" : "out"} manually if you haven't already.` Also remove the hardcoded newline mid-sentence ("asleep or the ⏎ server down") — let the client wrap. Add a unit test asserting the `out` variant says "Clock out".

## C. Code review focus (beyond the standard AGENTS.md checklist)

4. **The `dispatch` three-state machine is the subtlest thing in this phase.** Verify in code *and* tests: `"skipped"` (no row, disabled, or per-outcome toggle off) must **not** reset `blockedCount`; only `"blocked"` increments it; `"network"` and `"rate_limited"` must **not**. Conflating network errors with blocked would auto-disable users during a Telegram outage.

5. **`finalizeRun` must be the only place a terminal status is written.** `executeQueuedRun` previously wrote `status` in three places (credentials-missing early return, post-automation update, catch block). Confirm all three route through it, and that it uses `.returning()` — the notifier reads the *persisted* `steps` for the skip reason, and the in-memory run object's `steps` are stale.

6. **The rate limiter landed in `src/middleware/security.ts`, not the route file.** That is *more* correct than the spec — the module-ownership table says `express-rate-limit` is imported only there. Bless it as an as-built divergence. Then verify the option is **`keyGenerator`** (not `keyFn`, which silently falls back to IP keying and would rate-limit everyone behind one NAT together) and that it keys on the user id.

7. **Secrets.** The bot token must appear in no log line, response body, error message, or audit row. Check `lib/logger.ts`'s redact list gained the token keys; that `notification_settings_updated` audit metadata records `telegramChatIdSet`/`telegramTokenSet` **booleans** and never the values; that `GET /notifications` returns `telegramTokenSet` only.

8. **Frontend masked-token guard.** `NotificationsPanel` must send `telegramBotToken` only when the user actually typed one. Sending the masked placeholder would overwrite the real token with bullets.

9. **The sweep's four short-circuits**, each with a test that can fail: weekend and holiday return before any lookup; inside the grace window does nothing; a run existing today for that action — **any status, including `failure`** — suppresses the alert; a second sweep sends no duplicate.

10. `tenant-isolation.test.ts` was extended for `/notifications` — confirm those are real assertions, not placeholders. That test is the mechanism for catching an unscoped route added later.

11. Minor: `.env.example` was not updated for `MISSED_RUN_GRACE_MINUTES`. It has a default so nothing breaks, but new config belongs there.

## D. Ledger updates required in this commit — two existing entries are now stale

- `STATE.md` "Known gaps": **remove** the `authTagLength` entry (fixed in 6A) and the "a missed run is currently invisible" entry (closed by 6E).
- Move the notifications row from "Not built" to "Built and verified"; update "Suggested order from here" so phase 7 is next.
- `BACKLOG.md`: nothing to tick, but note item 4 (OTP submission via Telegram reply) is now **unblocked** — the transport exists.
- Spec note for the phase file: port `9` produced `ERR_UNSAFE_PORT` (Chrome blocks it) rather than a connection refusal. Same outcome, but `9999` is the more honest "server unreachable" simulation if the docs suggest a dead port again.
- **Do not create a tag.**
- **Not a code finding, but discovered during testing — a stale account has an enabled schedule.** `schedules` has two rows: one updated `2026-06-24` (05:30/19:00, `enabled=true`) belonging to a phase-1 test signup, and the real one. Cron is registered for that account and `fireCron` runs twice daily for it. Harmless today (no credentials → `startRun` returns `no_credentials`, no run row) but it quietly generates missed-run notices, and it is exactly the kind of leftover that becomes "why is the server trying to clock in a deleted colleague at 05:30". Clean up test accounts before any deploy; consider a note in `phase-5-deploy-ops.md` § 5.7 about auditing `users`/`schedules` before going live.
- **Reword the 6F `[manual]` gate in the phase file.** It asked for "a collapsible walkthrough", the implementer built one, and the gate passed — but the walkthrough contained a dead link nobody clicked (defect A2). A presence check is not a usability check. Change it to: *"follow the walkthrough end to end as a new user would, clicking every link"*. Same correction applies to any future phase shipping an in-app guide; the Gmail App Password walkthrough in phase 3 has never been re-tested this way either.

## E. `[manual]` check results (human-run, 2026-08-07)

| # | Check | Result |
|---|---|---|
| 1 | Settings round-trip — token shows `set`/`(unchanged)`, never the value; survives a save that doesn't touch the field | ✅ |
| 2 | Test button — message received naming `@drew_sprout_automator_bot` | ✅ |
| 2b | Rate limit — second test within 10s | ✅ `429`, "Please wait a few seconds" |
| 3 | Enable guard — `enabled:true` with no token | ✅ `400` "Set a Telegram bot token and chat ID before enabling notifications." |
| 3b | Token format regex — rejects a non-token string | ✅ `400` `fieldErrors.telegramBotToken: ["Invalid"]` (this is the SSRF guard; the token is interpolated into a URL) |
| 3c | `apiLimiter` reaches `/notifications` | ✅ `RateLimit-Policy: 120;w=60` present, plus full CSP/HSTS/X-Frame-Options |
| 4 | Partial update — clearing the token preserved `telegramChatId` and all four toggles | ✅ |
| 5 | Failure ⚠️ — dead-port `SPROUT_URL`, run failed in ~1s, message named the action and carried the error | ✅ · re-verified after the fix round: ANSI gone from Telegram **and** RunsPanel |
| 6 | Encrypted at rest — `telegram_bot_token_enc` opaque base64url | ✅ |
| 8 | Missed 🔴 — alert fired, no duplicate after 8 min / 2 sweeps, ledger correct | ✅ · message wording bug — see defect 20 |
| 8b | Investigated a second `missed_run_notices` row (`in`, 16:45 Manila) that sent no message. **Not a bug** — created when no `in` run existed (the real 05:31 clock-in was done directly in HRHub, so the app has no run row) and before notifications were configured at ~17:31, so `dispatch` correctly returned `"skipped"` and correctly left `blockedCount` alone. Confirms the suppression check works; also a live demonstration of backlog item 9 (insert-before-send burns the slot for a message that never sends) | ✅ |
| 7 | Skipped ℹ️ — message quotes the matched attendance row, not a generic "skipped" | ✅ after the fix round — rendered `Already clocked IN today (matched row "08/07/26 IN 05:31 AM") — skipping.` with the ℹ️ (benign) variant. Initially ❌ — see defect 12 |
| — | Incidental: full IMAP-OTP login against live HRHub still works post-refactor (prompt→code→authenticated in ~6s, run `05:38:01`) | ✅ |
| — | Incidental: one of two identical failure runs did not notify | ⚠️ see defect 17 |
| 8 | Missed 🔴 — exactly one message, no duplicate on the second sweep, one `missed_run_notices` row | ⬜ pending |
| 9 | Success ✅ — deferred to the next genuine clock action (cannot be faked without a real timesheet entry) | ⬜ deferred |
