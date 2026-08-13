# Backlog — ranked

Everything known-missing that isn't already a phase file, ordered by *when it will actually hurt you*, not by effort. Each entry says what breaks without it, so a future session can re-rank on evidence rather than vibes.

**Re-ranked 2026-08-08**, after phases T, 6, 7, 4A.2, 4B, L and 5 all landed. Four former entries are now done — see "Closed" at the bottom. **Updated 2026-08-10:** run-executor failure hardening completed (see "Closed").

**Updated 2026-08-11 — the ranking now assumes a possible ~30-user rollout**, which changes the character of the top items. § 3, § 4 and § 5 are no longer improvements; they are launch blockers, and § 3 cannot be closed without § 4. A new § 4 was inserted, so **items below it shifted by one** — old § 4–9 are now § 5–10.

---

> **Updated 2026-08-12 — brainstormed and re-scoped around a ~5-person pilot, not a 30-user launch.** The single large phase 8 was decomposed into three:
>
> | Phase | Content | From |
> |---|---|---|
> | [`phase-8-environment-and-limits.md`](./phases/phase-8-environment-and-limits.md) | compose passthrough + `jar` · `AUTH_RATE_LIMIT` 10→30 · real-client-IP keying | §§ 4, 3 (cheap option) |
> | [`phase-9-runs-history.md`](./phases/phase-9-runs-history.md) | `GET /runs` limit + `hasMore` · dates + Show more · Gmail-only copy | new · § 5 |
> | [`phase-10-admin-visibility.md`](./phases/phase-10-admin-visibility.md) | `ADMIN_EMAILS` + `requireAdmin` + overview + panel | § 8 |
>
> **Phase 9 shipped 2026-08-13** (gates 9A/9B/9C green; `[manual]` checks listed in `reviews/`-style handoff outstanding — dates, Show more, live-run polling, 375px, copy readability). § 5 part 1 (the in-app copy) is closed with it; part 2 (the onboarding one-pager) remains a human deliverable.
>
> **Deferred with reasons recorded below: §§ 2, 3 (the rewrite), 8 (until a second user exists).** Item numbers are **stable** — the phase files cite them, so do not renumber.

## 1. Delete `_archive/` — ✅ DONE (verified absent 2026-08-11)

**Deleted.** Confirmed gone from the working tree; `.gitignore:31` still carries the entry so it cannot come back accidentally. Left here rather than moved to "Closed" so the numbering phase 8 cites stays stable. Original rationale below.

**Ten seconds, and it is the only standing liability in the tree.** It holds a real `.env` and Sprout session cookies; `reference/supply-chain-and-ci.md` cites it as the near-miss that motivated the gitleaks hook. Gitignored, so this is about the working copy and any backup of it, not the repository.

The rebuild is complete and validated against live HRHub. Nothing in `_archive/` is referenced by any phase and the guardrails forbid reading it. **Delete it, and rotate anything inside that is still valid.** Left alone it eventually gets copied to a laptop, a backup, or a shared drive by someone who doesn't know what's in it.

## 2. Screenshot / data pruning

**Starts hurting the day this lives on a VPS, silently.** Roughly 8 full-page PNGs per run × 2 runs/day × every user, retained forever. Flagged as "recommended" in `phase-5-deploy-ops.md` § 5.6 and never built. On a 4 GB box with a handful of colleagues it becomes an ops incident months in — and by then the screenshots you need for a live drift investigation are buried under thousands you don't.

Prune `screenshots/<userId>/<runId>/` older than ~14 days; keep failures longer than successes if it's cheap, since those carry the forensic value. A nightly job in the container or on the host; either is fine.

> **Deferred 2026-08-12, deliberately.** Considered for phase 8 and cut. **This is triggered by the disk, not the headcount.** At 5 users it is ~24 MB/day; even at 30 it is ~145 MB/day, and the current host has 565 GB free — years of runway either way. It becomes urgent the day this moves to an 80–160 GB VPS, and not before. Deferring it does **not** cap the user count.

## 3. IP-keyed auth limiter locks out a whole team behind one NAT

**Bites the morning you onboard people.** Every colleague on the corporate network shares one IP. `authLimiter` is 10 requests / 15 min keyed by IP and, since 4B, covers login, signup, forgot-password and reset as a single shared budget. A few people fumbling passwords the same morning exhaust it for everyone — the rest get "Too many attempts" on their first try of the day with no hint that a colleague caused it.

Three options; **this needs a deliberate decision, not whichever is easiest to implement**:
- **Raise the budget** (10 → 30 / 15 min). Cheapest. A small trusted team rarely needs the defence 10 provides, and `AUTH_RATE_LIMIT` already makes it a config change.
- **Key by email with a looser IP backstop** (per-account 5/15 min, per-IP 30/15 min). Correct semantics — a brute-forcer targets an account, not an IP — but needs a per-email counter covering the "no such user" path too, keyed on the submitted (lowercased) address.
- **Give the reset endpoints their own limiter.** Stops a reset flow consuming the login budget; still leaves two humans sharing one budget within an endpoint.

> **Decided 2026-08-12: option 1 now, option 2 later.** Phase 8 § 8B takes the cheap route — default 10 → 30 — which is sufficient for a small trusted pilot and, after § 4 lands, is a config change rather than a code change. **This entry stays open for the email-keyed rewrite**, which is still the correct design and becomes necessary around ~25 users, where a per-IP budget that large stops defending anything.
>
> ⚠️ **A Cloudflare Tunnel deployment (§ 12) makes this *more* urgent, not less.** Behind a tunnel every request can arrive from the same address, so per-IP keying may be meaningless rather than merely coarse. Phase 8 § 8C mitigates the immediate danger by keying on `CF-Connecting-IP`, but per-account limiting is the real answer.

## 4. `docker-compose.yml` silently drops seven config keys

**Discovered 2026-08-11.** `config.ts` reads fourteen env keys; the compose `backend.environment` block passes **seven**: `NODE_ENV`, `PORT`, `DATABASE_URL`, `APP_ENCRYPTION_KEY`, `SESSION_SECRET`, `DATA_DIR`, `SPROUT_URL` (plus `TZ`). Missing:

`APP_URL`, `AUTH_RATE_LIMIT`, `MAIL_FROM`, `MAX_CONCURRENT_RUNS`, `MISSED_RUN_GRACE_MINUTES`, `RESEND_API_KEY`, `SIGNUP_ALLOWED`

**Setting any of these in the root `.env` does nothing when running under Docker, with no warning** — the container never sees them, so each falls back to its default. `.env.example` documents keys the deployed app cannot actually receive.

Sharpest consequence: **the cheapest fix for § 3 is unreachable.** That item's chosen remedy is "raise `AUTH_RATE_LIMIT` to 30 — it's already a config change, no code needed" — but through Compose it is stuck at 10 regardless of what `.env` says. § 3 cannot be closed without this.

The rest fail in the same quiet way: `APP_URL` stays `http://localhost:3000`, so every reset and verification link is dead; `RESEND_API_KEY`/`MAIL_FROM` are ignored, so mail silently never sends; `SIGNUP_ALLOWED` falls back to dev allow-all. Two of these (`APP_URL`, `SIGNUP_ALLOWED`) have production guards that refuse to boot, so `NODE_ENV=production` turns them into a loud failure instead — but the base compose defaults to `development`, which is exactly where they stay silent.

Add the seven to `backend.environment` with `${KEY}` passthrough, defaulting only where `config.ts` already does. Ten minutes, and it unblocks § 3.

> **Promoted to `phases/phase-8-environment-and-limits.md` § 8A (2026-08-12).** Work it from there.
>
> **Closed 2026-08-12 (phase 8 §8A).** All seven keys now pass through `docker-compose.yml` `backend.environment` with plain `${KEY}` interpolation and no compose defaults; `config.ts` treats the empty string Compose emits for an unset key exactly like an unset key (so a dial behaves identically inside and outside Docker); `docker-compose.prod.yml` re-declares only the keys it genuinely overrides. Same commit: `TRUST_PROXY_HOPS` joined the passthrough (§ 8C) so no new unreachable key was created.

## 5. Onboarding material + the Gmail-only constraint in the fine print

**Before you invite anyone.** `lib/imap-otp.ts` hardcodes `imap.gmail.com:993` — fine for Gmail *and* Google Workspace domains (same host, App Passwords identical), useless for Microsoft 365 or anything else. Anyone whose HRHub codes land in a non-Google mailbox needs a forwarding rule into Gmail before the tool works for them at all.

Two places, and the order matters:
1. **In the app, beside the field** — extend the Gmail App Password walkthrough in `CredentialsPanel` to say the mailbox must be Gmail or Google Workspace, and how to forward from another provider. This is what people read while setting up; a document is not.
2. **An onboarding one-pager or deck** for the "what is this and why would I use it" conversation: what it does, what it stores and how it's encrypted, the ~5-minute setup, what the notifications mean, and that it clocks *you* in under *your* credentials so accuracy remains your responsibility.

State plainly in both: **a missed-run alert means "the automation didn't run", not "you aren't clocked in"** — someone who clocked in by hand still gets one. Without that sentence, people either panic or learn to ignore the alerts.

> **Split 2026-08-12.** Part 1 (the in-app copy) is promoted to `phases/phase-9-runs-history.md` § 9C. **Part 2 (the one-pager) stays here** — it is a human deliverable, not code.
>
> **Part 1 closed 2026-08-13 (phase 9 § 9C).** The `CredentialsPanel` Gmail walkthrough now states the mailbox must be Gmail or Google Workspace and how to forward from another provider, and `NotificationsPanel` states that a missed-run alert means "the automation didn't run", not "you aren't clocked in". **Part 2 (the onboarding one-pager) remains open** and is listed as a `[manual]` deliverable of § 9C.

## 6. Password reveal on every password field

**Most acute exactly where it is missing.** `CredentialsPanel` and `NotificationsPanel` have a reveal toggle; **`AuthPage` (login / signup / forgot) and `ResetPasswordPage` do not** — and those are the fields with a **12-character minimum**, typed by someone creating or resetting a password they have never typed before, often on a phone. A mistyped password at signup is discovered on next login; at reset it locks the person out of the account they were mid-way through recovering.

`RevealInput` is currently **duplicated verbatim** in both panels. The fix is to extract it to `components/ui/` (or `components/RevealInput.tsx`) and use the one implementation in all four places — not to write a third copy. Keep the existing behaviour: `InputGroup` + `InputGroupAddon` with an eye icon, `aria-label` toggling between "Show" and "Hide", `type` swapping between `password` and `text`.

## 7. Retry on transient failure

**A flaky portal at 05:30 currently costs the whole day.** The standing position — "the next scheduled run is the de-facto retry" (`01-PROJECT-BRIEF.md`) — is only true if *tomorrow* counts as a retry interval. For a clock-in it doesn't.

`navigateToPortal` already retries 3× on server errors, so this covers failures *past* navigation: login timeouts, OTP never arriving, the clock dialog not appearing. One retry at +10 minutes, hard cap of two attempts, **only for `failure`** — never `skipped`, or a fail-safe verification skip turns into repeated clock attempts, which is exactly the double-clock the guard exists to prevent. Needs an `attempt` column on `runs` and care with the partial unique index so a retry can't collide with its own predecessor.

## 8. Admin visibility

**You currently learn a colleague's automation is broken when they tell you.** `users.is_admin` exists, is returned by `publicUser`, and gates nothing (`phase-4-security.md` § 4B.7 sketches it). Minimum useful version: an admin-only read endpoint listing each user's last run per action with status and timestamp. Not impersonation, not credential access — just "whose automation is failing". Rank rises sharply the moment anyone else is using this.

> **Specced but gated 2026-08-12.** Fully written up in `phases/phase-10-admin-visibility.md`. **Do not build it until a second person has an account** — with one user the overview is a table with one row and zero information. The phase also documents what the summary above understates: `is_admin` is *inert*, so there is currently no way for anyone to become an admin, and the grant mechanism must be built before any admin surface can exist.

## 9. OTP submission via Telegram reply

**The manual OTP fallback is unusable in the one scenario it was built for.** At 05:30 you are asleep; if IMAP is slow the run waits five minutes and dies. The dashboard paste-in box only helps someone already awake and watching.

Phase 6 landed the transport, the settings row and the routes, so the channel exists. What remains is the interactive half: a run waiting for OTP asks, and a reply satisfies the bridge. Needs long-polling `getUpdates` or a webhook (a webhook means a public HTTPS endpoint, so realistically after a real deploy), plus care that a code arriving from Telegram binds to the right `runId`. Biggest item here, and the most satisfying.

## 10. Documentation drift (residual)

`04-STACK-SCAFFOLD-AND-CONFIG.md` still names Vite 6 / TS 5.6 as targets; as-built is Vite 8 / TS 6. A note was added at the top of that file, but the dependency block below it still reads as though 6 were the target.

## 11. OTP-fix test debt: a non-discriminating test and an unredacted error path

**Low priority — test-quality debt found in the OTP-retry review (2026-08-11), not a shipping defect.** Don't let either slip into a later refactor:

1. `app/backend/test/services/otp-acquisition.test.ts:73` ("stops only the winning attempt's poller") **does not discriminate** — it passes against the reintroduced run-scoped-controller bug because the mock `pollForOtp` ignores the signal. Only the first test (`:42-71`) protects the fresh-controller property; a future edit deleting that first test would silently lose the coverage. Make the second test assert on the captured signal (snapshotted at call time), or delete it so a removal is loud.
2. `errorSummary` (`lib/text.ts`) is a **pure passthrough**: if any error cause ever carried a secret, it would land verbatim in `runs.error` and the Telegram failure message (`renderRunFinishedMessage` embeds it). No *current* source can produce such a cause (no `src` error interpolates a credential; imapflow 1.4.2 redacts creds), and the new rule-4 integration assertion (`otp-error-unwrap.test.ts:143-146`) is vacuous by construction — benign fixed-string causes. **Fix:** route `errorSummary` output through a string-redaction step mirroring the key list `lib/logger.ts` already maintains (`password`, `appPassword`, `gmailAppPassword`, `code`, `otp`, `botToken`, …) before the message is persisted or notified, plus a unit test injecting a secret-bearing cause — that test fails today, so the redaction ships with it.

## 12. Deployment path: domain → Resend → Cloudflare Tunnel

**The cheapest way to make this reachable, and the only one that unblocks password reset.** Added 2026-08-12 after costing a Hetzner VPS at ~₱2,500–2,800/month (Singapore region — the premium the original spec priced at EU rates; see `phase-5-deploy-ops.md` § 5.1).

The host is a ThinkPad E14 Gen 5: 40 GB RAM, 12 threads, 565 GB free — **more capable than a ₱2,754/month CPX32**. What it lacks is a public hostname and outbound mail.

**One purchase unlocks both, and it is not the expensive part.** A domain via Cloudflare Registrar is at-cost, ~$10/yr ≈ **₱700/yr (~₱58/month)** — roughly 2% of the VPS. Both remaining blockers require it:
- **Resend** free tier only delivers to your own account address from `onboarding@resend.dev`; reaching colleagues needs a verified domain with SPF/DKIM.
- **Cloudflare Tunnel** quick tunnels are free and domain-less but hand out a random `*.trycloudflare.com` URL **that changes on every restart** — which breaks `APP_URL` and every reset link already sent. A stable named tunnel needs a domain on Cloudflare.

**Steps:** register the domain in Cloudflare → add Resend's SPF/DKIM records to Cloudflare DNS, verify, take an API key → Zero Trust → Networks → Tunnels → create tunnel, install the `cloudflared` connector (simplest as a container in `docker-compose.yml` so it starts and stops with the stack) → public hostname `sprout.<domain>` → service `http://backend:3000` → set `APP_URL`, `RESEND_API_KEY`, `MAIL_FROM`, `SIGNUP_ALLOWED`, `NODE_ENV=production`.

**Five of those six keys are among the seven § 4 discards, so phase 8 § 8A is a hard prerequisite.** Once the tunnel is up, also set `TRUSTED_CLOUDFLARE_PEERS` (see `DEPLOY.md` § 4.1) to the address the backend sees from `cloudflared` — without it every tunnel user arrives from the same peer and the rate limiters share one auth bucket for the whole team (the § 3 / § 8C danger). Each entry is validated at boot (the same refuse-to-start stance as `SIGNUP_ALLOWED`): a `/0` prefix (trusts *every* peer of that family) and a CIDR with host bits set are rejected when the app starts, so a typo cannot silently widen or disable the gate — write the network form (e.g. `172.20.0.0/16`) or the single address with its full mask (`172.20.0.5/32`). `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` in the build images and both setup scripts keeps the unattended rebuild from blocking on a pnpm download prompt.

**What it does *not* fix:** the home ISP and laptop uptime become the dependency, and **Docker Desktop needs a logged-in Windows session** — a Windows Update reboot leaves the stack down until someone logs in, which at 05:30 means a missed run for everyone. That is the largest unattended risk on this host and none of the above addresses it.

**What it makes obsolete:** Cloudflare terminates TLS, so `docker-compose.prod.yml` + `Caddyfile` (built for a VPS) are unnecessary in this topology, and `DEPLOY.md` would need rewriting around a tunnel. Keep the Caddy artifacts — they stay correct if a VPS ever happens.

## 13. Runs history row-expand control is not keyboard-reachable

**Found 2026-08-14 (phase 9 round-1 tester F4) — pre-existing, NOT a phase-9 regression.** In `RunsPanel.tsx` the entire `<tr>` is the expand target (with `onClick` and no `tabIndex`/`role`); verified that before this phase the committed version had the identical `<tr onClick>`, and phase 9 only changed `py-2` → `py-3`. Tab from "Show more" jumps straight to `BODY` — 10 clickable rows, 0 focusable. The phase's spec pointed `ui-ux-pro-max` § 1 at this exact control and the ≥44 px touch target was met (measured 65 px), but keyboard nav was left broken. Fix: `tabIndex={0}` + `role="button"` + Enter/Space handler (or a real button in the first cell). Independent of the phase-9 working tree; record it so it is not lost.

## 14. Tighten the e2e seed helper's database guard

**Found 2026-08-14 (phase 9 round-2 tester F2) — LOW, non-blocking, test-only helper.** `app/backend/test/e2e-seed-runs.ts` guards with `current_database()` `.includes("test")`, which matches *any* database name containing that substring (`latest`, `contest`, `sprout_prototype` all pass — proven by seeding 3 rows into a throwaway DB named `latest`). The realistic risk (a bare invocation against the real `sprout` DB) is already blocked. Tighten to an exact `sprout_test` match or a `_test`-suffix rule the next time the helper is touched. See `STATE.md` § Known gaps.

---

## Closed

- ~~Session hardening leftovers~~ — idle timeout, password reset, email verification and account deletion all shipped in 4B. Data export was deliberately skipped.
- ~~Adopted-but-unbuilt improvements~~ — `useRuns`' refetch callback is typed (`Query<Run[]>`), the `QueryClient` has explicit defaults, and `credentials_deleted` is in the audit union.
- ~~`DEPLOY.md` does not exist~~ — created in phase 5.
- ~~`phase-5` § 5.3 says `node:22-alpine`~~ — corrected; the only remaining mention is the correction note itself.
- ~~Run executor failure hardening~~ — decrypt moved inside `executeQueuedRun`'s try/catch so corrupt `*_enc` or credential DB errors take the normal failure path and notify instead of becoming unhandled rejections; `.catch` backstop on the executor call marks runs failure and notifies; `notified_at` column added to `missed_run_notices` for Telegram outage retries (NULL after failed dispatch means next sweep retries); global `unhandledRejection`/`uncaughtException` handlers log and prevent silent crashes; integration tests for both paths. Setup scripts (`setup.ps1`/`setup.sh`) for first-run environment: generate secrets, start stack, apply migrations, health-check. **Happy path unverified** (requires manual UI setup steps; see scripts line 151-152).
