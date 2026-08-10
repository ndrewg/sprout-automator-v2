# Backlog — ranked

Everything known-missing that isn't already a phase file, ordered by *when it will actually hurt you*, not by effort. Each entry says what breaks without it, so a future session can re-rank on evidence rather than vibes.

**Re-ranked 2026-08-08**, after phases T, 6, 7, 4A.2, 4B, L and 5 all landed. Four former entries are now done — see "Closed" at the bottom.

---

## 1. Delete `_archive/`

**Ten seconds, and it is the only standing liability in the tree.** It holds a real `.env` and Sprout session cookies; `reference/supply-chain-and-ci.md` cites it as the near-miss that motivated the gitleaks hook. Gitignored, so this is about the working copy and any backup of it, not the repository.

The rebuild is complete and validated against live HRHub. Nothing in `_archive/` is referenced by any phase and the guardrails forbid reading it. **Delete it, and rotate anything inside that is still valid.** Left alone it eventually gets copied to a laptop, a backup, or a shared drive by someone who doesn't know what's in it.

## 2. An unhandled rejection in the run executor crashes the process — silently

**Found 2026-08-08 while planning a machine move; not yet fixed.**

`executeQueuedRun` decrypts credentials at lines ~117–130, **outside** its `try` block (which starts at 161). `run-queue.ts:30` invokes it as `void this.executor(runId).finally(…)` with **no `.catch`**, and there is **no global `unhandledRejection` handler**. So anything that throws before line 161 — a wrong `APP_ENCRYPTION_KEY`, or a transient DB error on the credentials `select` — rejects unhandled, and Node 22 terminates the process.

**Both of phase 6's safety nets miss it.** `finalizeRun` never runs, so there is no ⚠️ failure notification; and because a run row *does* exist for today, the missed-run sweep stays quiet too. The user is told nothing. With `restart: unless-stopped` the container comes back, orphan recovery marks the run `failure`, and the same thing happens at the next scheduled time — a silent daily crash loop.

**Most likely trigger is a machine move**, where a fresh `APP_ENCRYPTION_KEY` meets a migrated database.

Fix: a `.catch` on the executor call that marks the run `failure` and notifies (reuse `finalizeRun`), plus a global `unhandledRejection` handler that logs as a backstop. Consider moving the decrypt inside the `try` so it takes the normal failure path.

## 3. Screenshot / data pruning

**Starts hurting the day this lives on a VPS, silently.** Roughly 8 full-page PNGs per run × 2 runs/day × every user, retained forever. Flagged as "recommended" in `phase-5-deploy-ops.md` § 5.6 and never built. On a 4 GB box with a handful of colleagues it becomes an ops incident months in — and by then the screenshots you need for a live drift investigation are buried under thousands you don't.

Prune `screenshots/<userId>/<runId>/` older than ~14 days; keep failures longer than successes if it's cheap, since those carry the forensic value. A nightly job in the container or on the host; either is fine.

## 4. `notified_at` on `missed_run_notices`

**Protects the feature that justified all of phase 6.** The sweep inserts the notice row **before** dispatching (D6 — the database decides who sends). If every retry of that send fails during a long Telegram outage, the row exists, the user was never told, and no later sweep retries it: the notice is permanently silent. Rare after the defect-17/18 transport retry, but the missed alert is precisely the one where silence is worst.

Add a `notified_at` column: the sweep dispatches, and a failed send leaves it NULL so the next sweep retries once. The unique index on `(user_id, manila_date, action)` already prevents double-notify for successful sends, so the insert-then-send order stays.

## 5. IP-keyed auth limiter locks out a whole team behind one NAT

**Bites the morning you onboard people.** Every colleague on the corporate network shares one IP. `authLimiter` is 10 requests / 15 min keyed by IP and, since 4B, covers login, signup, forgot-password and reset as a single shared budget. A few people fumbling passwords the same morning exhaust it for everyone — the rest get "Too many attempts" on their first try of the day with no hint that a colleague caused it.

Three options; **this needs a deliberate decision, not whichever is easiest to implement**:
- **Raise the budget** (10 → 30 / 15 min). Cheapest. A small trusted team rarely needs the defence 10 provides, and `AUTH_RATE_LIMIT` already makes it a config change.
- **Key by email with a looser IP backstop** (per-account 5/15 min, per-IP 30/15 min). Correct semantics — a brute-forcer targets an account, not an IP — but needs a per-email counter covering the "no such user" path too, keyed on the submitted (lowercased) address.
- **Give the reset endpoints their own limiter.** Stops a reset flow consuming the login budget; still leaves two humans sharing one budget within an endpoint.

## 6. Onboarding material + the Gmail-only constraint in the fine print

**Before you invite anyone.** `lib/imap-otp.ts` hardcodes `imap.gmail.com:993` — fine for Gmail *and* Google Workspace domains (same host, App Passwords identical), useless for Microsoft 365 or anything else. Anyone whose HRHub codes land in a non-Google mailbox needs a forwarding rule into Gmail before the tool works for them at all.

Two places, and the order matters:
1. **In the app, beside the field** — extend the Gmail App Password walkthrough in `CredentialsPanel` to say the mailbox must be Gmail or Google Workspace, and how to forward from another provider. This is what people read while setting up; a document is not.
2. **An onboarding one-pager or deck** for the "what is this and why would I use it" conversation: what it does, what it stores and how it's encrypted, the ~5-minute setup, what the notifications mean, and that it clocks *you* in under *your* credentials so accuracy remains your responsibility.

State plainly in both: **a missed-run alert means "the automation didn't run", not "you aren't clocked in"** — someone who clocked in by hand still gets one. Without that sentence, people either panic or learn to ignore the alerts.

## 7. Password reveal on every password field

**Most acute exactly where it is missing.** `CredentialsPanel` and `NotificationsPanel` have a reveal toggle; **`AuthPage` (login / signup / forgot) and `ResetPasswordPage` do not** — and those are the fields with a **12-character minimum**, typed by someone creating or resetting a password they have never typed before, often on a phone. A mistyped password at signup is discovered on next login; at reset it locks the person out of the account they were mid-way through recovering.

`RevealInput` is currently **duplicated verbatim** in both panels. The fix is to extract it to `components/ui/` (or `components/RevealInput.tsx`) and use the one implementation in all four places — not to write a third copy. Keep the existing behaviour: `InputGroup` + `InputGroupAddon` with an eye icon, `aria-label` toggling between "Show" and "Hide", `type` swapping between `password` and `text`.

## 8. Retry on transient failure

**A flaky portal at 05:30 currently costs the whole day.** The standing position — "the next scheduled run is the de-facto retry" (`01-PROJECT-BRIEF.md`) — is only true if *tomorrow* counts as a retry interval. For a clock-in it doesn't.

`navigateToPortal` already retries 3× on server errors, so this covers failures *past* navigation: login timeouts, OTP never arriving, the clock dialog not appearing. One retry at +10 minutes, hard cap of two attempts, **only for `failure`** — never `skipped`, or a fail-safe verification skip turns into repeated clock attempts, which is exactly the double-clock the guard exists to prevent. Needs an `attempt` column on `runs` and care with the partial unique index so a retry can't collide with its own predecessor.

## 9. Admin visibility

**You currently learn a colleague's automation is broken when they tell you.** `users.is_admin` exists, is returned by `publicUser`, and gates nothing (`phase-4-security.md` § 4B.7 sketches it). Minimum useful version: an admin-only read endpoint listing each user's last run per action with status and timestamp. Not impersonation, not credential access — just "whose automation is failing". Rank rises sharply the moment anyone else is using this.

## 10. OTP submission via Telegram reply

**The manual OTP fallback is unusable in the one scenario it was built for.** At 05:30 you are asleep; if IMAP is slow the run waits five minutes and dies. The dashboard paste-in box only helps someone already awake and watching.

Phase 6 landed the transport, the settings row and the routes, so the channel exists. What remains is the interactive half: a run waiting for OTP asks, and a reply satisfies the bridge. Needs long-polling `getUpdates` or a webhook (a webhook means a public HTTPS endpoint, so realistically after a real deploy), plus care that a code arriving from Telegram binds to the right `runId`. Biggest item here, and the most satisfying.

## 11. Documentation drift (residual)

`04-STACK-SCAFFOLD-AND-CONFIG.md` still names Vite 6 / TS 5.6 as targets; as-built is Vite 8 / TS 6. A note was added at the top of that file, but the dependency block below it still reads as though 6 were the target.

---

## Closed

- ~~Session hardening leftovers~~ — idle timeout, password reset, email verification and account deletion all shipped in 4B. Data export was deliberately skipped.
- ~~Adopted-but-unbuilt improvements~~ — `useRuns`' refetch callback is typed (`Query<Run[]>`), the `QueryClient` has explicit defaults, and `credentials_deleted` is in the audit union.
- ~~`DEPLOY.md` does not exist~~ — created in phase 5.
- ~~`phase-5` § 5.3 says `node:22-alpine`~~ — corrected; the only remaining mention is the correction note itself.
