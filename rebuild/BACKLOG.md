# Backlog — ranked

Everything known-missing that isn't already a phase file, ordered by *how likely it is to actually hurt you*, not by effort. Each entry says what breaks without it, so a future session can re-rank on evidence rather than vibes.

Promoted to phases: **run notifications + missed-run reconciliation** → `phases/phase-6-notifications.md`; **pause / leave days** → `phases/phase-7-schedule-pause.md`; **signup gating** → `phases/phase-4-security.md` § 4A.2.

---

## 1. Retry on transient failure

**Without it:** a flaky portal at 05:30 costs you the whole day. The current position — "the next scheduled run is the de-facto retry" (`01-PROJECT-BRIEF.md`, scope boundaries) — is only true if you consider *tomorrow* an acceptable retry interval. For a clock-in, it isn't.

`navigateToPortal` already retries 3× on server errors, so this only concerns failures *past* navigation: login timeouts, OTP never arriving, the clock dialog not appearing. One retry at +10 minutes, hard cap of two attempts total, and only for runs that failed (never `skipped` — the fail-safe skip must stay terminal, or a verification failure turns into repeated clock attempts, which is precisely the double-clock the guard exists to prevent).

Cheap after Phase 6, because a notification tells you when it finally gave up. Needs an `attempt` column on `runs` and care with the partial unique index — a retry must not collide with its own predecessor.

## 2. Screenshot / data pruning

**Without it:** the disk fills, quietly. Roughly 8 full-page PNGs per run × 2 runs/day × every user, retained forever. Flagged as "recommended" in `phase-5-deploy-ops.md` § 5.6 and never built. On a 4 GB VPS with a handful of colleagues this becomes an ops incident months in, at which point the screenshots you actually need for a live drift investigation are buried in thousands you don't.

Prune `screenshots/<userId>/<runId>/` older than ~14 days. Keep failures longer than successes if it's easy — those are the ones with forensic value. A nightly cron in the container or a host-level job; either is fine.

## 3. Admin visibility

**Without it:** you find out a colleague's automation has been broken for a week when they tell you.

`users.is_admin` exists, is returned by `publicUser`, and gates nothing. `phase-4-security.md` § 4B.7 sketches this. Minimum useful version: an admin-only read endpoint listing each user's last run per action with status and timestamp. Not impersonation, not credential access — just "whose automation is failing". Rank rises sharply the moment you onboard anyone.

## 4. OTP submission via Telegram reply

**Without it:** the manual OTP fallback is unusable in the one scenario it was built for. At 05:30 you are asleep; if IMAP is slow the run waits five minutes and dies. The dashboard paste-in box only helps someone already awake and watching.

> **Unblocked (2026-08-07):** phase 6 landed the Telegram transport (`lib/telegram.ts`), the notification settings row, and the settings routes — the channel now exists. What remains is the interactive half: a run waiting for OTP could ask, and a reply could satisfy the bridge. Needs either long-polling `getUpdates` or a webhook (a webhook means a public HTTPS endpoint, so realistically post-Phase-5), plus care that a code arriving from Telegram is bound to the right `runId`. Real work, real payoff.

## 5. Session hardening leftovers

Idle session timeout (`phase-4-security.md` § 4B.4) is a one-line comparison in `findValidSession` and limits the blast radius of a stolen cookie. The rest of 4B (email verification, password reset, account deletion, export) matters once real colleagues are on it — and password reset in particular, because right now a forgotten password is unrecoverable without database surgery.

## 6. Adopted-but-unbuilt improvements from `02-DECISIONS-AND-ARCHITECTURE.md`

Small, listed there, still open:
- **#5** — type the `useRuns` refetch callback instead of `(query: any)`. The one `any` in the data layer.
- **#7** — explicit `QueryClient` defaults (`staleTime`, `retry: 1`, `retry: false` for `useMe`). Partly done; verify.
- `credentials_deleted` as a distinct audit event — **done** (the union has it).

## 7. Documentation drift

- `04-STACK-SCAFFOLD-AND-CONFIG.md` still targets Vite 6 / TS 5.6; as-built is Vite 8 / TS 6 (corrected only in `phase-3-frontend.md`'s margin note).
- `04`'s repo layout lists a `DEPLOY.md` that doesn't exist — Phase 5 will create it.
- `phase-5-deploy-ops.md` § 5.3 says the frontend build stage is `node:22-alpine`; the actual Dockerfile and doc `04` both say `node:22-bookworm-slim` (Debian, for Tailwind v4's native engine). The Alpine mention is stale and would break the build if followed.

## 8. Onboarding material + the Gmail-only constraint in the fine print

**Without it:** a colleague gets halfway through setup, discovers the OTP reader only speaks to Gmail, and stops.

`lib/imap-otp.ts` hardcodes `imap.gmail.com:993`. That covers Gmail **and Google Workspace domains** (same host, App Passwords work identically) but **not** Microsoft 365 or anything else. Anyone whose HRHub one-time codes land in a non-Google mailbox needs a forwarding rule into a Gmail account before this tool can work for them at all.

Two places this needs to appear, and the order matters:
1. **In the app, next to the field** — extend the existing Gmail App Password walkthrough in `CredentialsPanel` with a line stating the mailbox must be Gmail or Google Workspace, and how to forward from another provider. This is what people actually read while setting up; an external document is not.
2. **An onboarding doc** (deck or one-pager) for the "what is this and why would I use it" conversation — what the tool does, what it stores and how it's encrypted, the ~5-minute setup, what the notifications mean, and that it clocks *you* in under *your* credentials so accuracy is still your responsibility.

Also worth stating plainly in both: a missed-run alert means "the automation didn't run", not "you aren't clocked in" — someone who clocked in manually will still get one.

## 9. `_archive/` still contains live secrets

Not a feature — a liability. It holds a real `.env` and session cookies; `reference/supply-chain-and-ci.md` cites it as the near-miss that motivated the gitleaks hook. It is gitignored, so this is about what sits in the working tree and any backup of it, not about the repository.

The rebuild is complete and validated against live HRHub. Nothing in `_archive/` is referenced by any phase, and the guardrails forbid reading it. **Delete it** (and rotate anything it contains that is still valid). Left alone it will eventually be copied to a laptop, a backup, or a shared drive by someone who doesn't know what's in it.

## 10. Missed-run notice can still be lost on the very first send

**Without it:** the reconciliation sweep inserts the `missed_run_notices` row **before** dispatching (D6 — the DB decides who sends). If every retry of that send fails (a long Telegram outage), the row exists but the user was never told, and no later sweep will retry it — the notice is permanently silent. The defect-17/18 transport retry makes a lost send rare but not impossible, and the missed alert is the one where silence is worst (the whole point of the feature).

The real fix is a **`notified_at` column** on `missed_run_notices`: sweep dispatches, and a failed send leaves `notified_at` NULL so the next sweep retries it once without risking a duplicate (the unique index on `(user_id, manila_date, action)` already prevents double-notify for *successful* sends). Small schema change; the sweep's insert-then-send order stays.
