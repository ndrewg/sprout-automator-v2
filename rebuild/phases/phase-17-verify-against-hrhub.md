# Phase 17 — Verify against HRHub, not against ourselves

**Goal:** the app believes HRHub's attendance card, not its own click. After acting it reads the card again. A clock-out needs a clock-in. A result it can't confirm is reported as **unknown** and alerted, never auto-retried. The OTP it submits is one HRHub sent *for this login*.

**Why this exists.** The 2026-10-14 architecture review found the two worst outcomes still possible: a **double clock** and a **clock-out with no clock-in**. The second already happened on 2026-08-20, when the clock-in failed and the 16:15 clock-out succeeded. Brief non-negotiable #6 ("fail safe") holds only when the card is missing entirely:

| # | Today | Evidence |
|---|---|---|
| 1 | "Success" means a dialog with the expected title appeared. The card is never read again after acting. | `automation/clock.ts:143-164` |
| 2 | No dialog within 30 s **after "Yes" was clicked** is reported as an ordinary `failure` and **auto-retried**. If the click had landed, only the guard stands between the retry and a double clock. | `clock.ts:181-185`, `services/retry.ts` |
| 3 | The guard is fail-safe when the card is missing, but **fail-open** when it can't read the rows. It knows three date formats; anything else means "No IN row found, proceeding". | `clock.ts:42-46`, `:84-86` |
| 4 | The clock-out guard only looks for an existing OUT row. It never checks for today's IN. | `clock.ts:71-74` |
| 5 | The IMAP OTP search uses `SINCE now − 5 min`, but **IMAP `SINCE` has day precision** (RFC 3501), and nothing filters by received time afterwards. If the new mail is slow, a 16:15 run can submit the 05:30 code. When no mail from Sprout's sender matches, it falls back to **any sender**. Used codes are remembered per run only. | `lib/imap-otp.ts:88-100`, `services/otp-acquisition.ts` |
| 6 | Every safety rule above lives inside Playwright code. Tests `vi.mock` the whole of `runAutomation`, so none of them is under test. | `test/integration/retry*.test.ts` |

**Attach for this session:** `02-DECISIONS-AND-ARCHITECTURE.md` (D5, D7, D19, and D20), `reference/hrhub-automation-playbook.md`, `phases/phase-14-retry.md`, `reference/testing-strategy.md`, `03-CONVENTIONS-AND-GUARDRAILS.md`.

> 🆕 **LATEST, UP-TO-DATE TECH, CODE AND REFERENCES. Mandatory.** Fetch current docs (Context7, then official docs) for every library, tool and service this phase touches. Write against the installed version's current API; add any new dependency at its latest stable release (within the pnpm cooldown); report outdated dependencies instead of bumping them mid-phase. Current docs beat any version or API this spec names. Full rule: `AGENTS.md` hard rule 1.

> 📡 **Fetch live docs (Context7):** Playwright 1.60 (locators, `innerText`), imapflow (`fetch` with `internalDate`, search criteria). **Vision model** for any screenshot triage (see `00-START-HERE.md` § Model & runtime).

**Depends on phase 15** (the lifecycle decides retries from the outcome this phase reports).

**Scope discipline:** no selector rewrites "while we're here". Selectors change only where this contract needs a new read, such as reading the card again after acting. HRHub invariants in D5 stay load-bearing.

---

## 17A — A portal seam with two adapters

**Contract:**
- Define a narrow **HRHub portal** interface (in `automation/`) for what a clock attempt needs from HRHub:
  - make sure we're logged in (the session file and the OTP callback stay inside the Playwright adapter);
  - **read today's attendance** as structured data: whether today's IN is present, whether today's OUT is present, and whether the card was readable;
  - press the clock action;
  - take a screenshot.
- **Playwright adapter:** today's `browser` / `portal` / `login` / `clock` / `screenshot` code moved behind that interface. `playwright` is still imported only under `src/automation/` (D5).
- **Scripted fake adapter** (test-only): a sequence of card states and click results, so the orchestration below runs in milliseconds with no Chromium. **Two adapters justify the seam.**
- A screenshot failure (I/O error) must never fail a run (`screenshot.ts:12-14` currently throws through).

---

## 17B — The clock attempt: verify, then decide

**Contract:** one orchestration module above the portal seam (it can be today's `runAutomation`, slimmed down) runs:

1. **Read the card before acting.**
   - **Unreadable card** means skip with "could not read attendance": no card at all, or **no row's date parses in any known format**, which signals that HRHub changed its format. Today the second case proceeds; it must stop. A card that shows rows for *earlier* days but none for today is readable, and "not clocked today" is a valid answer.
   - **IN action, today's IN present:** skip, "already clocked in".
   - **OUT action, today's OUT present:** skip, "already clocked out".
   - **OUT action, today's IN absent:** skip with **"no clock-in found today, not clocking out"**, and alert. Never create half a record.
2. **Press the action.** Classify any failure **before the confirmation click** as **not done**. That's safe to retry (selector miss, timeout, HRHub down).
3. **After the click, read the card again**, with a short bounded wait for HRHub to update:
   - today's row for the action is present: **done** (`success`), whatever the dialog showed;
   - HRHub showed an explicit error dialog and the card shows no row: **not done**, retryable;
   - no confirmation and no row, or the card is unreadable: **unknown**.
4. **Unknown is a new outcome**, never auto-retried. The lifecycle (phase 15) records it, and the message says: *"Clock-in state unknown: HRHub didn't confirm and the attendance card doesn't show it. Check HRHub before clocking manually."*
   - **Storage:** prefer `status = 'failure'` with a machine-readable `outcome` / `error_kind` column, so the partial unique index and the status enum stay untouched. A new status value is also acceptable. The coder decides and records it in D20.

**Tests (unit, fake adapter):** one per row above, including:
- card readable with only yesterday's rows, IN action: proceeds;
- rows with an unparseable date format: skips;
- OUT with no IN today: skips with the alert;
- click, no dialog, row appears on re-read: success;
- click, no dialog, no row: unknown, and phase 15's retry decision does **not** schedule a retry;
- a failure before the click is retried as today.

**Tests (fixtures):** the card parser against saved HTML or text from real screenshots of the card, in each of the three known date formats plus an unknown one. Ask the operator for a current card snapshot, and **redact** names and employee IDs before committing it.

---

## 17C — OTP anchored to the request

**Contract:**
- Record the instant the OTP was **requested**: when the login reaches the OTP page or submits the request. Pass it to the IMAP poll.
- After fetching, **discard any message whose `internalDate` is earlier than that instant minus 60 s** (to absorb clock skew between Gmail and the host).
- **Remove the any-sender fallback** (`imap-otp.ts:94-99`). If nothing from Sprout's sender arrives, the run fails with "no OTP mail from Sprout's sender within 5 min", which names the likely cause (a changed sender address). The manual paste race is unchanged, so a human can still finish the run.
- Update **D7**: its "`SINCE` now − 5 min" line has always been wrong about precision.

**Tests (unit):** a message received before the request is ignored even when it is the newest UID with a valid code; a non-Sprout sender is never used; a message 30 s before the request (skew) is accepted.

---

## Verification Gate (the whole phase)

```
cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration
git grep -n "from \"playwright\"\|from 'playwright'" -- app/backend/src | grep -v "src/automation/"   # must be empty
```

**`[manual]`: must not be claimed as passed** (live HRHub; take screenshots and triage them with a vision model):

| # | Check | Pass looks like |
|---|---|---|
| 1 | A scheduled clock-in on a normal day | `success`; the log shows the card read **after** the action with today's IN row |
| 2 | A manual "Clock in" after the scheduled one has succeeded | `skipped: already clocked in`; HRHub shows one IN |
| 3 | A manual "Clock out" on a day with no IN (e.g. a paused morning) | `skipped: no clock-in found today`, plus an alert; HRHub unchanged |
| 4 | The 16:15 run's OTP | The log shows the code came from a message received after that run's request |
| 5 | Card snapshot fixtures | Committed with names and IDs redacted; the parser reads them |

Commit per the loop in `AGENTS.md`. Tag `phase-17-complete` when the table is filled in.

---

> ⚠️ **As-built (2026-10-14):** decisions and divergences from the implemented phase.
>
> **1. Module layout.**
> - **`automation/portal-seam.ts`** — the narrow `HRHubPortal` interface (`ensureLoggedIn`, `readTodayAttendance`, `pressClockAction`, `takeScreenshot`, `close`), plus `ClockAction` (moved here; `clock.ts` re-exports it so every existing importer is unchanged) and `ClockPressResult` (`confirmed` | `error_dialog` | `no_dialog`).
> - **`automation/playwright-portal.ts`** — the Playwright adapter. Holds the browser, the storage-state file, the login/OTP flow (including the stale-session recovery), the card locator and the clock selectors. `playwright` is still imported only under `src/automation/`.
> - **`automation/clock-attempt.ts`** — the orchestration: read → decide → press → read again → decide. Pure of Playwright.
> - **`automation/runAutomation.ts`** — now a ten-line wrapper that builds the adapter and delegates; it keeps its name because `services/runs.ts` and six integration tests are written against it.
> - **`automation/attendance-card.ts`** — the pure card parser (`parseAttendanceCard`, `parseRowDate`).
> - **`lib/run-outcome.ts`** — the outcome vocabulary, `shouldScheduleRetry`, `unknownOutcomeDetail`, `NO_CLOCK_IN_SKIP_REASON`.
>
> **2. `unknown` is stored as `status='failure'` + `runs.outcome='unknown'`** (migration **`0012_run_outcome.sql`**, one `ALTER TABLE ... ADD COLUMN "outcome" text`, renamed from the generated `0012_aromatic_liz_osborn.sql` per the project's naming convention). The status enum and the partial unique index are untouched, as the phase preferred. `finishRun` gained an optional `outcome` and asks `shouldScheduleRetry(status, outcome)` — so the retry is skipped by the same code path that records it, and `notified`/`pinged` still treat it as a reached outcome (the alert fires; the heartbeat pings). **D20 updated** with this decision. `outcome` is NULL for every other terminal status.
>
> **3. `clock.ts` was edited more than "move the code".** The already-clocked guard (`isAlreadyClockedForToday`) is REMOVED — its three date formats moved into the parser, its fail-safe branching into the orchestration — and `performClockAction`'s result is now the discriminated `ClockPressResult` instead of `{success, message?, error?}`, because § 17B needs "explicit error dialog" told apart from "no dialog at all". **Every selector, wait, screenshot and log line is byte-identical to the playbook**; only the three `return`s changed. The old string sentinel ("Clock action completed but no confirmation dialog appeared") is gone with it.
>
> **4. What the live markup settled (and one reading the phase left open).** The operator's saved dashboard snapshot (`view-source…EmployeeDashboard.aspx.html`, untracked, **must not be committed**) was read as text:
> - the card is `div.widget` > `.widget-title` (title + the `clock-in-out-dropdown`) > `.widget-content` > `.widget-body`, whose rows are the last **4** attendance logs (`GetLastLogs`, `{logCount: 4}`);
> - each row is `date \t IN|OUT \t time` on ONE line (the guard's `split("\n")` is therefore correct), and the date is `moment(LogTime).format('MM/DD/YY')` — so the three known formats are right and `MM/DD/YY` is the one that matters;
> - the success dialog is title `Time Entry Confirmation` / `Clocking Status Update`; the **error** dialog uses the SAME class with title `Clock In`/`Clock Out` and the server text in the body — which is exactly how `performClockAction` separates the two;
> - the card's empty state is a `No Current Logs` div, and `myAttendanceLogs().length == 0` also renders it **when the AJAX behind it failed**. The phase's literal rule ("no row's date parses … unreadable") therefore decides this case: an empty/unreadable card is `skipped: could not read attendance`, never "not clocked today". That is the fail-safe direction (playbook invariant 5, AGENTS.md rule 10) and it is the only reading that cannot double-clock, but it means **a brand-new account with no attendance history will not be auto-clocked** — the alert says so. Worth watching on the first live run.
>
> **5. The card-parser fixtures — deferred at the phase-17 commit, supplied 2026-10-14.** The phase committed with **synthetic card text only** (`test/automation/attendance-card.test.ts`, the three known formats plus a day-first unknown one) because the operator's redacted real snapshot had not yet been provided. **Supplied 2026-10-14 (the deferred §17B item):** `app/backend/test/fixtures/attendance-card-2026-10-14.txt` — the operator's real Attendance widget innerText (`"Webpage, Complete"` save, read with **JavaScript disabled** so Knockout's scripts don't reset the log list to `"No Current Logs"`; names and employee IDs absent) — plus a `describe("attendance card — real snapshot (2026-10-14)")` block of three tests, the third a **strict redaction guard**: every line must be a known chrome label (`Attendance`, `Clock In/Out`, `Clock In`, `Clock Out`, `Show Team Attendance`, `No Current Logs`) or match `^\d{2}/\d{2}/\d{2}\t(?:IN|OUT|BROKEN OT - IN|BROKEN OT - OUT)\t\d{2}:\d{2} (?:AM|PM)$`. That guard is deliberately **stricter than `parseRowDate`**, which is a substring match and would accept a name/ID line riding a dated row. The phase's "(fixtures)" bullet is now **closed** (manual row 5); a new manual row (11) tracks future markup drift against the next live card read.
>
> **6. Unit tests live in `test/automation/`** — a new unit-project include entry in `vitest.config.ts` (the seam's tests mirror `src/automation/`). `test/automation/fake-portal.ts` is the second adapter; it is not a `*.test.ts` file, so nothing collects it as a suite.
>
> **7. § 17C implementation detail.** The "OTP request instant" is captured in `services/otp-acquisition.ts` on the **first** `waitForOtpCode()` call of the run (i.e. when the login flow reaches the OTP page and asks for a code), via an injected `now` — never `Date.now()` inline — and reused for every later attempt of the same run. `fetchLatestOtp` takes an options object now (`{lookbackSeconds, excludeCodes, requestedAfter}`) rather than positional arguments.
>
> **8. Not on the card, not in this phase:** exposing `outcome` through `GET /runs` (the route whitelists fields and the UI would need a badge to make it useful) — the alert is the user-facing signal. Moved to `BACKLOG.md` only if the operator wants it.

