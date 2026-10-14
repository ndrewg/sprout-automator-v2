# Phase 17 — tester's addendum (verify against HRHub)

**Tester session:** 2026-10-14, work PC (`DESKTOP-3SV8V8A`). Round 1 — no earlier `phase-17-addendum.md` existed.
**Method:** every gate re-run from cold; every new test probed red→green by breaking the code it protects; filesystem (not git) search for playwright imports; DB inspected directly in `sprout_test`; source restored byte-exact after probing (`git diff` shows only the implementer's changes + this file).

---

## A — Structural verification (what I confirmed myself, so the reviewer can trust rather than repeat)

**A1 — Gates, re-run by me (not pasted from the report):**

| Gate | Command | Result |
|---|---|---|
| Lint | `cd app/backend && pnpm lint` | ✅ exit 0 (oxlint, zero warnings) |
| Typecheck | `pnpm typecheck` | ✅ exit 0 |
| Unit | `pnpm test` | ✅ **322 passed / 322** (29 files) — matches STATE.md's new baseline exactly |
| Integration | `pnpm test:integration` | ✅ **188 passed / 188** (33 files) — matches; Postgres up via `docker compose up -d postgres`, tests hit `sprout_test` only |
| Frontend unit | `cd app/frontend && pnpm test` | ✅ 5/5 (untouched by the phase, baseline preserved) |
| E2E | `pnpm build && pnpm test:e2e` | ✅ **22/22** (not in the report; run because the backend executor path changed and e2e boots the real backend) |

No count went down. `hostname` confirmed work PC before anything ran; no container was recreated; no write to live `sprout`.

**A2 — Playwright import rule, filesystem search (rule 9 / D5).** `Get-ChildItem -Recurse src | Select-String "from \"playwright\""` — **6 imports, every one under `src/automation/`**: `browser.ts:1`, `clock.ts:18`, `login.ts:1`, `playwright-portal.ts:13`, `portal.ts:1`, `screenshot.ts:2`. The only other `playwright` hits in `src/` are the word in comments (`attendance-card.ts`, `clock-attempt.ts`, `paths.ts`, `text.ts`, `runs.ts`). The untracked `playwright-portal.ts` — which the phase gate's `git grep … | grep -v` would have missed — is accounted for. ✅

**A3 — Diff vs report.** `git status`/`git diff` match the Handoff exactly: 9 src files, 6 test files, `vitest.config.ts`, `drizzle/meta/_journal.json`, plus untracked `portal-seam.ts`, `playwright-portal.ts`, `clock-attempt.ts`, `attendance-card.ts`, `lib/run-outcome.ts`, `test/automation/` (4 files), `test/integration/clock-unknown.test.ts`, `test/lib/run-outcome.test.ts`, `drizzle/0012_run_outcome.sql` + `meta/0012_snapshot.json`. **No source file changed but unreported.** Doc edits (`rebuild/STATE.md`, `phase-17-verify-against-hrhub.md` as-built notes, `02-DECISIONS-AND-ARCHITECTURE.md` D7/D20) were read line-by-line and are accurate against the code — they belong in the reviewer's commit. Two working-tree files are **not phase work**: `.opencode/agent/orchestrator.md` (bash `"*": deny`→`allow`) and `opencode.json` (permission schema change) — implementer disclaims them; **do not stage them with the phase commit** (B6).

**A4 — Migration hygiene.** `0012_run_outcome.sql` is **new and untracked**, one line: `ALTER TABLE "runs" ADD COLUMN "outcome" text;`. The only committed drizzle artifact touched is `meta/_journal.json` (one added entry, idx 12). **No committed migration was edited.** Direct check in `sprout_test` (`\d runs`): `outcome | text | nullable`; `status` still `NOT NULL` text; `runs_one_active_per_user` byte-identical (`UNIQUE (user_id) WHERE status IN ('pending','running')`); `retry_at` untouched. ✅

**A5 — No fixture / no invented PII.** No `test/fixtures/` directory exists; the only `*card*` file under `test/` is `attendance-card.test.ts`, which builds synthetic `date\tIN|OUT\ttime` strings (no names, no IDs). The real dashboard artifacts sit untracked at the repo root (`screencapture-…png`, `view-source_…html`) and are correctly flagged in STATE.md as must-not-commit. ✅

**A6 — New tests probed: every one proven able to fail.** I broke each protected behaviour, confirmed the specific test(s) went red, restored, confirmed green:

| # | Probe (temporary edit, since reverted) | Red result |
|---|---|---|
| 1 | `shouldScheduleRetry` returns `true` for `unknown` (`lib/run-outcome.ts`) | 2 failed: `run-outcome.test.ts` "NEVER retries an unknown failure" + `clock-attempt.test.ts` "is UNKNOWN … never retried" |
| 2 | Parser fail-open: `unreadable()` returns `readable: true` (`attendance-card.ts`) | 4 failed in `attendance-card.test.ts` (incl. the day-first drift case and the empty-state case) |
| 3 | OUT-without-IN guard disabled (`clock-attempt.ts:143`) | 1 failed: "skips an OUT action when today has no IN — never a half record" |
| 4 | OTP pre-request `internalDate` discard disabled (`imap-otp.ts`) | 1 failed: "discards a message received before the request…" |
| 5 | Any-sender search restored (`from: OTP_SENDER` removed) | **3 failed** in `imap-otp.test.ts` (incl. "never uses a non-Sprout sender" and "names Sprout's sender…") |
| 6 | `safeScreenshot` rethrows (`clock-attempt.ts`) | 1 failed: "a screenshot failure never fails the run (17A)" |
| 7 | IN already-clocked guard removed (`presentRow` ignores `inRow`) | 2 failed: the double-clock skip test + the decision-logging test |
| 8 | `finishRun` wiring bypassed back to `status === "failure"` (`run-lifecycle.ts`) | 1 failed **integration**: "stores 'unknown' … schedules NO retry" — so the unknown→no-retry claim is proven at the *wiring* level, not just the predicate |
| 9 | `screenshot()` helper rethrows (`screenshot.ts`) | 1 failed: "resolves … when the capture throws" |

After restoring all nine, the full unit suite re-ran **322/322** and `clock-unknown.test.ts` **4/4**; `git diff` contains zero `PROBE` markers and the src diffstat is identical to the pre-probe snapshot (§ A3). **Nothing in the report's test claims is a test that cannot fail.**

**A7 — Double-clock / half-record behaviour, traced through the real code (not only tests):**
- IN with today's IN on the card → `skipped`, `pressCount 0` (`clock-attempt.ts:136-141`) — no second clock. Proven by probe 7.
- OUT with no IN today → `skipped` + `NO_CLOCK_IN_SKIP_REASON`, never presses (`clock-attempt.ts:143-151`); the notifier renders it as its own ⚠️ alert ("Clock-out skipped — no clock-in today … Nothing was clocked out.", `notifications.ts:140-151`), tested at both unit (`notifications.test.ts`) and integration (`clock-unknown.test.ts:177-195`) level — never the benign ℹ️.
- Re-read finds the row → `success` **even when the dialog was an error_dialog or absent** (`clock-attempt.ts:177-189`); tested both directions.
- Error dialog + readable card with no row → `failure` (retryable) (`clock-attempt.ts:191-197`).
- No confirmation + no row, or unreadable re-read → `unknown` (`clock-attempt.ts:199-207`); stored `status='failure'` + `outcome='unknown'` (`runs.ts:95-104`), alerted under the ❓ header (`notifications.ts:118-131`), and the lifecycle's retry gate refuses it (`run-lifecycle.ts` via `shouldScheduleRetry`) — probe 8 proved the integration test catches a wiring regression here.
- Unreadable card **before** acting → skip, and the read is not repeated (`clock-attempt.ts:130-134`; test asserts `readCount()===1`). A read that *throws* is also unreadable, never a thrown run (`clock-attempt.ts:70-88`).

**A8 — OTP (17C).** Request anchor captured once per run on the first `waitForOtpCode()` (`otp-acquisition.ts:46-51`), injected clock (`now`, never inline `Date.now()`), passed as `requestedAfter`; `fetchLatestOtp` discards `internalDate < requested − 60 s` and searches **Sprout's sender only** — the date-only fallback is gone and the timeout error names the sender (`imap-otp.ts`). All five required cases exist as tests: pre-request discard, 30 s-skew acceptance, non-Sprout never used, post-request preferred, no-anchor legacy behaviour (test lines 260/276/236/290/305). Current imapflow docs (Context7 `/postalsys/imapflow`, fetched today) confirm `search({since, from}, {uid: true})` and fetch-time `internalDate` are the current, non-deprecated API.

**A9 — Attack surface.**
- *Tenant isolation:* no new routes or request-scoped DAOs in the diff; `listRuns` still scoped to `req.user.id` (`routes/runs.ts:67`); `outcome` is **not** in the `publicRun` whitelist (`routes/runs.ts:25-37`) — confirmed against the phase's "not exposed" claim.
- *Secrets:* new log lines carry sender/since/uid/internalDate/notBefore only — never a code; the unknown alert body is the constant `unknownOutcomeDetail()`; `run-outcome.test.ts` asserts no secret-shaped content. The test's fake bot token carries `// gitleaks:allow` and is obviously synthetic.
- *Unbounded anything:* the card is read at most twice per attempt; `pollForOtp` stays bounded by `timeoutMs`; no loop, retry or log added.
- *Orphan/restart interplay:* an interrupted mid-click run is recovered as plain `failure` (outcome NULL → retryable, phase-15 behaviour); the retry then hits the card guard, so a click that *had* landed is caught as "already clocked" rather than double-clocked — defence in depth holds by construction.

**A10 — Ledger accuracy.** STATE.md's pre-edits (queue row 17, the phase-17 "Built and verified" row, the 322/188 baseline, the six "notes the next session needs") and the phase file's as-built notes (module layout, migration name, empty-card-is-unreadable trade, fixtures deferred, OTP anchor detail) were each checked against the code and are correct. D7's correction and D20's as-built block match `imap-otp.ts`/`run-outcome.ts`/`run-lifecycle.ts` behaviour.

---

## B — Defects found

**No BLOCKING defects.** Every safety claim the report makes was probed and held (§ A6, A7). The items below are low-severity; none ships wrong or unsafe behaviour.

1. **(Low — doc) Stale comment naming a deleted function.** `src/services/retry.ts:27` still says "`isAlreadyClockedForToday` fails safe by skipping on doubt" — that function was deleted in this phase; the guard is now the card read in `clock-attempt.ts`. *Failure scenario:* a future reader greps for a function that no longer exists and re-derives the old (fail-open) mental model. One-line comment fix in the commit.
2. **(Low — doc) STATE.md's 🔴 deploy-blocker section does not name `0012`.** Lines ~51-53 name `0008` and `0009–0011`; the Known-gaps section and queue row do cover 0012 ("applied to `sprout_test` only"), but a deployer skimming only the blocker list could boot the new backend against an unmigrated laptop DB. *Failure scenario:* `finishRun`'s `UPDATE … SET outcome=…` raises `42703` on every run finish; `failRunFromExecutor`'s second `finishRun` throws the same way; runs stick at `running`, the partial unique index then **blocks all new runs** — the automation silently bricks until `pnpm db:migrate`. Mitigated by the phase's manual row 6 and the Known-gaps note, but the top-of-file blocker list is also still stale in a second way ("one behind again: phase 15 adds 0008" — predates 0009–0012). Reviewer: ask the coder to add a 0012 line in the same commit.
3. **(Info — accepted design) `runs.outcome` has no DB-level CHECK.** It is `text`, constrained only by the Drizzle TS enum `["unknown"]`. Any raw SQL could store other values; only `finishRun` writes it today. Documented decision (D20), acceptable — recorded so the reviewer signs off knowingly.
4. **(Info — hardening, pre-existing) imapflow `from:` is a *contains* match.** Current docs: "`from` — From: header contains". A mail whose From merely *contains* `no-reply@sprout.ph` would pass the sender gate; a wrong code is then rejected by HRHub (login fails, manual paste still available), and this scoping predates the phase. Not blocking; a future hardening could match the envelope address exactly.
5. **(Info — judgement call, conservative) `error_dialog` + unreadable re-read → `unknown`, not retryable `failure`.** `clock-attempt.ts:191-197` requires `after.readable` for the "not done" branch; if the re-read fails, the run is `unknown` and is **not** retried even though HRHub explicitly said no. The phase's wording ("error dialog and the card shows no row") cannot be evaluated on an unreadable card, and fail-safe (no retry) is defensible — flagged so the reviewer confirms intent rather than discovery.
6. **(Process) Two non-phase files are dirty in the working tree:** `.opencode/agent/orchestrator.md` and `opencode.json` (tooling permission changes; implementer disclaims). Plus the two untracked real-HRHub artifacts at the repo root, which **must not be committed** (they contain an unredacted live dashboard). Stage by name only.

---

## C — What I could not verify, and why (read this section hardest)

- **Every live-HRHub behaviour.** No Chromium was pointed at HRHub and none should be. That includes: the card locator (`text=Attendance` → ancestor xpath) finding the widget on the real dashboard *today*; `innerText` actually rendering rows as `date\tIN|OUT\ttime` on one line (the parser's whole model rests on the 2026-10-14 snapshot reading — the owed redacted fixture is what turns this belief into a test); the 3 s settle wait being enough for `GetEmployeeDashBoard()` to repaint the card (too short → spurious `unknown` on real runs; the constant is injectable but its production value is a guess); the success/error dialog title assumptions in `clock.ts` against the next HRHub deploy; the mobile `.mbl-btn` fallback.
- **The real 16:15 OTP provenance** (manual row 4): needs a live unattended clock-out where Sprout's mail arrives after the request instant, on the scheduled host, with real Gmail INTERNALDATE behaviour including the 60 s skew assumption.
- **Applying `0012` to the live `sprout` databases** (work PC dev DB and the laptop) and the still-unrun from-empty schema diff (phase 15 manual row 1, which 0012 now sits on top of). I only inspected `sprout_test`, which the integration suite migrates itself.
- **The brand-new-account empty card** on a real account with no attendance history: the code path is tested (`No Current Logs` → unreadable → skip + alert) but whether that is the *right product trade* for the operator's first colleague is a live judgement call (STATE.md's phase-17 notes flag it).
- **Flakiness:** phase 15 § 15E's twice-from-cold protocol was not repeated here; I ran each suite once (plus targeted re-runs after probes) with stable counts.
- **E2E scope:** 22/22 passed, but the e2e suite never performs a real clock attempt (automation is out of scope there), so it proves only that the rewiring didn't break the app shell, auth, schedule and history panels.
- **Whether the unknown alert *looks* right on a phone** — HTML rendering in Telegram is a human check (manual row below).

---

## D — `[manual]` checks (human only — results column deliberately empty)

Carried forward from the phase file's table (rows 1–5), plus the migration/deploy rows this phase owes. **Do not tick any of these from an agent session.**

| # | Check | Exact command / click sequence | Pass looks like | Results |
|---|---|---|---|---|
| 1 | Scheduled clock-in verifies against the card | On the scheduled host, wait for (or trigger) a normal-day 05:30 clock-in; open the run in the dashboard and the backend log | Run `success`; steps show "Reading the attendance card again…" then "Clock IN verified against the attendance card (row \"…\")"; HRHub shows one IN | |
| 2 | Manual clock-in after the scheduled one succeeded | Dashboard → "Clock in" button after row 1 passed | Run `skipped` with "Already clocked IN today"; **HRHub still shows exactly one IN for the day** | |
| 3 | Manual clock-out with no clock-in | On a day whose morning was paused/failed, click "Clock out" | Run `skipped` "no clock-in found today, not clocking out"; a ⚠️ Telegram alert ("Clock-out skipped — no clock-in today"); **HRHub unchanged** | |
| 4 | 16:15 OTP comes from a post-request message | Let the real 16:15 clock-out run unattended with Gmail IMAP configured; read the run's log/steps | The "OTP code taken from message" line's timestamp is after the run's OTP-request instant; if an older Sprout mail exists, the "OTP message predates this run's request — discarded" line appears | |
| 5 | **DEFERRED — operator's redacted card snapshot fixture** | Operator saves the current attendance-card markup/text, redacts names + employee IDs, commits under `app/backend/test/fixtures/`, adds a parse test; then `cd app/backend && pnpm test` | Fixture parses to the expected IN/OUT rows; suite still green | |
| 6 | Apply `0012` (and `0008`–`0011` if still pending) to the **live** `sprout` DBs | On work PC dev DB and the laptop: `pnpm db:migrate`, then `docker compose exec postgres psql -U sprout -d sprout -c "SELECT id, when FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 3;"` and `\d runs` | Migration rows include `0012_run_outcome`; `\d runs` shows nullable `outcome text`; backend boots (`/health` → `db: ok`) | |
| 7 | Laptop deploy ORDER (new — see B2) | Before starting the new backend image on the laptop, confirm 6 passed; then start and watch the first run finish | No `42703 undefined_column` in logs; runs reach terminal statuses; the run queue doesn't jam at `running` | |
| 8 | Brand-new account, empty card | Sign up a fresh account with credentials but no HRHub history; run a manual clock-in | Run `skipped` "Could not read the attendance card…"; ⚠️ alert; **no clock attempt dispatched** — operator confirms this trade is acceptable | |
| 9 | Restart mid-attempt doesn't double-clock | Kill the backend while a run is `running` (mid-click window), restart, let the retry fire | Orphan is notified + retried; the retry reads the card and either proceeds or skips "already clocked" — **HRHub shows at most one IN** | |
| 10 | The unknown alert on a phone | Force or wait for one `unknown` (or re-send via the message renderer) | Telegram shows "❓ **Clock-in state unknown**" + "Check HRHub before clocking manually."; no stack trace, no code | |

---

## 🆕 LATEST, UP-TO-DATE TECH, CODE AND REFERENCES (checked 2026-10-14)

- **No new dependencies** were added by this phase (all new code is TypeScript on existing deps). ✅
- **Current-docs check:** imapflow APIs used by 17C (`client.search({since, from}, {uid: true})`, fetch-time `internalDate`, `getMailboxLock`) were verified against **current** imapflow docs via Context7 (`/postalsys/imapflow`) today — current, not deprecated. Playwright usage is relocated pre-existing code behind the seam; its selectors are the pinned playbook's, exempt per AGENTS.md rule 1.
- **Outdated dependencies observed on the registry today (reported, NOT bumped — correct mid-phase behaviour; reviewer decides follow-ups):**
  - `imapflow` installed `^1.7.2` → latest **2.4.2** (a major behind; implementer already reported this).
  - `playwright` pinned `1.60.0` → latest **1.64.0** (AGENTS.md names 1.60 as the stack; still behind latest — reported).
  - `vitest` `^4.1.11` → latest **5.0.4** (devDependency, a major behind — **new observation**, not in the implementer's list).
  - In-range, worth knowing: `mailparser` ^3.9.15 → 3.9.39; `drizzle-orm` ^0.45.2 → 0.45.4; `date-holidays` ^3.35.0 → 3.37.0; `express` ^5.1.0 → 5.3.0.
- **References:** D7's RFC 3501 day-precision claim about IMAP `SINCE` is correct per current RFC text; the phase file's as-built notes cite live markup captured 2026-10-14 (current). No outdated doc links found in the diff.

---

*End of addendum. Restoration proof: after all nine probes, `git diff` over `app/backend/src` is identical to the implementer's pre-probe diffstat and contains no probe markers; the only file this tester added is this addendum.*
