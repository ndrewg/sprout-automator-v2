# OTP retry bugfix (2026-08-11) — review addendum

Hand to the reviewer alongside the implementer's handoff. This is the tester's attempt to make the report's claims false. Nothing was fixed and no `git` write was performed; every fault injection was restored byte-identical (verified by diff hash) before the final gate re-run.

---

## A. Structurally verified (confirm, don't redo)

Gates re-run independently, in order, on the actual working tree:

| Gate | Result |
|---|---|
| `pnpm lint` | exit 0 (oxlint, no output) |
| `pnpm typecheck` | exit 0 (`tsc --noEmit`) |
| `pnpm test` | 110 passed (14 files) |
| `pnpm test:integration` | 99 passed (19 files) |

- `src/services/otp-acquisition.ts:33-68` — `createOtpAcquirer` creates a **fresh `AbortController` per `waitForOtpCode()` call** (line 44, inside the function), passes `excludeCodes: submittedCodes` to `pollForOtp` (line 51), records each handed-out code into the run-scoped `submittedCodes` Set **before returning** (line 59), and aborts + cancels in the attempt's own `finally` (lines 61-63). `submittedCodes` is also returned so the run exposes what it has submitted.
- `src/services/runs.ts:155-160` — `createOtpAcquirer(runId, imapAvailable ? creds : null)`; the acquirer is created **outside** `runAutomation` so both retry acquisitions share the run's code memory. `runs.ts:183` uses `errorSummary(err)` in the catch.
- `src/lib/imap-otp.ts:17-26` — exported `PollForOtpOptions` gained `excludeCodes?: ReadonlySet<string>`; `fetchLatestOtp` takes it as a third param (line 77) and skips an excluded code (line 109), falling through to `no_code` when every candidate is excluded; `pollForOtp` threads it through (lines 148-152).
- `src/lib/text.ts:14-29` — `errorSummary` unwraps `AggregateError` into its joined cause messages; falls back to `err.message` / `String(err)` otherwise.
- `src/services/notifications.ts:283-288` — `hasRunToday` now anchors `since = now - 24h` to the sweep's injected `now` instead of the wall clock; `sweepMissedRuns` passes its captured `now` at line 375.
- **No migration generated.** `drizzle/` is unchanged (6 migration files, last written 2026-08-10). Matches the spec's "no schema change" requirement.
- `src/automation/clock.ts` untouched (`git diff`/porcelain empty). OTP regex `(?<!\d)(\d{4,6})(?!\d)` byte-identical to HEAD (git's diff hunks for imap-otp.ts never touch the `extractOtpCode` body).
- `reference/crypto-and-otp-specs.md` carries the dated as-built note describing the new options.

## B. Defects found

1. **[non-blocking] Rule 4 is not enforced at the `errorSummary` boundary — it is a pure passthrough.** The report's claim "the unwrap must not drag credential material into runs.error" is only as good as the upstream error messages. Empirically: an `AggregateError` whose causes contain `password=hunter2-app-pass-p4ssw0rd-otp-48213` produces `errorSummary` output containing the password, the app password and the OTP code verbatim; that string is persisted to `runs.error` and rendered into the outbound Telegram message (`renderRunFinishedMessage` embeds the error verbatim, `notifications.ts:97-102`). The new integration test's rule-4 assertion (`otp-error-unwrap.test.ts:143-146`) is **vacuous by construction** — its causes are benign fixed strings, so the assertion would pass even if a cause carried a secret. I could find no *current* source of a secret-bearing message: no `src` error interpolates a credential, and imapflow (resolved `1.4.2`) redacts credentials from proxied-URL logs and reports auth failures as server response text ("Invalid credentials (Failure)"), not echoed creds. Failure scenario: a dependency upgrade or a future error site that echoes auth input silently ships the secret to runs.error and Telegram. Recommend either redacting at `errorSummary` (design change) or at minimum a unit test that injects a secret-bearing cause — note that test would fail today, so it implies the redaction too. Reviewer's call.
2. **[non-blocking] `otp-acquisition.test.ts:73-81` ("stops only the winning attempt's poller") does not discriminate.** It passes against the reintroduced run-scoped-controller bug because the mock `pollForOtp` ignores the signal. Only the first test (`:42-71`) discriminates. Coverage is not lost today, but the second test is a no-op guard — a future edit that deleted the first test would silently lose the protection.
3. **[process — record for the reviewer] STATE.md self-certification.** The implementer moved the ledger to "Built and verified" and wrote "implementation verified" (STATE.md rows at :33-34, the "Suggested order" item at :48, and the Known-gaps entry at :56) before any review. The **content is accurate** — I verified every claim in those rows, including the 110/99 gate counts and the failure chain description — so the reviewer inherits correct facts, but the "Built and verified" verdict is the reviewer's to issue at commit time. Minor: the "Suggested order" list has two items numbered `2.` (STATE.md:49-50).
4. **[minor] Unreported changes in the same uncommitted tree.** `DEPLOY.md` (as-built note: base compose silently drops seven config keys) and `rebuild/BACKLOG.md` (30-user re-ranking, new § 4) were changed in the same working tree but are not mentioned in the OTP rows of STATE.md. `STATE.md:49` does reference the re-ranking; the `DEPLOY.md` change has no ledger entry at all. Docs-only, no gate covers them.
5. **[minor] "No production behaviour change" (hasRunToday) is strictly imprecise.** Pre-fix, the `-24h` window was anchored to `Date.now()` at each `hasRunToday` call; post-fix it is anchored to the sweep-start `now` (captured once at `notifications.ts:356`). In production both are `new Date()` milliseconds apart, and the post-fix window is marginally *wider* (can only include a run near the boundary that the pre-fix code could have missed). No substantive behaviour change; acceptable claim with this caveat.

## C. What I could not verify (and why)

- **A live unattended stale-OTP retry reaching real HRHub** — the residual `[manual]` item, and the only true proof of the whole fix. The dev DB's most recent run is the 16:15 clock-out on 2026-08-10, status `skipped`, empty error — it did not exercise the retry path.
- **A real stale OTP in a real inbox.** The exclusion logic was exercised only against the `vi.mock("imapflow")` fake inbox in `test/lib/imap-otp.test.ts`; a real Gmail inbox's UID ordering and dedup behaviour are assumed, not proven.
- **A real retry with no human present** — the scenario the 05:30 failure on 2026-08-11 was; that run is not in this dev DB (it was the live deployment).
- **The Telegram message actually rendering in a chat.** The integration test asserted against a local recording HTTP server (`otp-error-unwrap.test.ts`), not Telegram.
- **imapflow error shapes** — the package.json range is `^1.3.3`, resolved `1.4.2`; the "errors don't echo credentials" finding was checked against `1.4.2`'s source.
- **Which exact tests the "able to fail" claim covered** — the handoff report itself was not included in the relayed brief; I reconstructed the claims from STATE.md and the task description. Step-3 fault injections were verified against the tests as they exist.

## D. `[manual]` check results (human-run — results column empty)

| # | Check | Exact steps | What a pass looks like |
|---|---|---|---|
| 1 | Live stale-OTP retry via IMAP | On a real account with IMAP creds set: start a clock-in while the inbox already holds an older, already-rejected Sprout OTP email, with a newer code about to arrive within ~5 min; run unattended. Or reproduce by letting the first submitted code be stale (e.g. reuse yesterday's code email) so HRHub rejects it and the retry re-races | Run reaches `success`; `runs.error` empty; steps show the second acquisition got a **fresh** code (a code different from the first); no "IMAP polling aborted" and no OTP timeout. The 16:15 clock-out is the natural live probe |
| 2 | Forced failure message quality | Trigger a run failure at the OTP step (e.g. unplug network so both manual and IMAP time out) and read the Telegram alert + `runs.error` | Alert and DB error show the joined causes (`OTP timeout …; IMAP polling aborted`) — **not** the literal "All promises were rejected" |
| 3 | No secret in a failed run | In the same forced failure, inspect `runs.error`, the Telegram text, and the pino log line | Neither the email address, the Sprout password, the Gmail app password, nor any 4–6 digit code appears anywhere |
| 4 | Normal IMAP OTP still works | Start a clock-in with a fresh code arriving; no manual paste | Acquired and submitted without human action; success |
| 5 | Manual-paste bridge still works | Start a clock-in with IMAP creds **absent**, then paste a code from the dashboard | Run succeeds; the pasted code is submitted |
