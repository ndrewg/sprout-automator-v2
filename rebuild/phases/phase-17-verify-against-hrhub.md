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
