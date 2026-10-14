# Phase 16 — Workday gate and the day calendar

**Goal:** one module answers *"should user U be clocked on Manila day D, and why?"* Each user can see and flip that answer for any upcoming day in a calendar, and hears about the next day the evening before. The worst outcome this app can produce is a **false clock-in** (2026-08-21, Ninoy Aquino Day). This phase makes the decision visible and correctable before it happens.

**Why this exists.** The 2026-10-14 architecture review found:
- **The decision is duplicated** in four places, each with its own idea of "now" and of Manila time: `fireCron` (`services/scheduler.ts:257-309`), `attemptRun` (`services/retry.ts:174-193`), the missed-run sweep (`services/notifications.ts:416-418`, `:509`), and the schedule route. On top of that there are five Manila-time helpers (`ph-holidays.ts:41`, `wall-clock-tick.ts:83`, `retry-registry.ts:37`, `notifications.ts:362-377` with hard-coded UTC+8, `holidays.ts:173-184`). The scheduler imports slot arithmetic **from the notifications module**.
- **Holiday data can only add skip days.** Nothing can say "the library is wrong, this is a workday", and leave days need a pause range.
- **Library `public` skips are silent** (`notifications.ts:335`), so a wrong library date is invisible until HR notices.
- **The Gazette layer is dead.** officialgazette.gov.ph sits behind a Cloudflare bot challenge (403 "Just a moment…", confirmed 2026-10-14 with browser-like headers too). `gazette_holidays` has never held a row.

**Decided 2026-10-14 (with the operator; recorded in the revised D9):**
- **Remove the Gazette layer.** The library (`date-holidays`) is the source, and `EXTRA_HOLIDAYS` stays as the company-wide manual override.
- **No second automatic source.** Google's public PH holiday feed was evaluated and rejected:
  - it labels almost everything "Public holiday", with no regular/special or national/regional distinction;
  - it lists Mawlid nationally on 08-26 where the library has an observance on 08-25;
  - it's undocumented and could change format or disappear.

  The human is the cross-check, through the calendar and the heads-up.
- **A per-user day calendar** with two kinds of override: **skip** (leave, or an intended miss) and **work anyway** (a holiday the user works). Stored in the database, so changes take effect without a restart. This replaces the `EXTRA_WORKDAYS` config idea.
- **An evening heads-up** about the next workday's decision.
- **Every skip notifies**, including plain library holidays. The existing `notify_on_skipped` toggle is the mute.

**Attach for this session:** `02-DECISIONS-AND-ARCHITECTURE.md` (D9, D17, D18), `phases/phase-11-holiday-skip-types.md`, `phases/phase-7-schedule-pause.md`, `reference/api-contract.md`, `reference/database-schema.md`, `03-CONVENTIONS-AND-GUARDRAILS.md`.

> 🆕 **LATEST, UP-TO-DATE TECH, CODE AND REFERENCES. Mandatory.** Fetch current docs (Context7, then official docs) for every library, tool and service this phase touches. Write against the installed version's current API; add any new dependency at its latest stable release (within the pnpm cooldown); report outdated dependencies instead of bumping them mid-phase. Current docs beat any version or API this spec names. Full rule: `AGENTS.md` hard rule 1.

> 📡 **Fetch live docs (Context7):** shadcn `calendar` (react-day-picker), react-day-picker modifiers, TanStack Query v5 mutations, Drizzle. **Skills:** `shadcn`, `ui-ux-pro-max` (Platform: Web), `tailwind-design-system`.

**Depends on phase 15** (the lifecycle module is the gate's main caller).

---

## 16A — The Workday gate module (backend)

**Contract:**
- One deep module, e.g. `services/workday.ts`. Given a user, a Manila day and an injected `now`, it returns a decision **with its reason**:
  - work;
  - skip: weekend;
  - skip: paused (D18 range);
  - skip: the user's skip day;
  - skip: holiday (name and type; library or company override);
  - work: the user's "work anyway" day, overriding a holiday.
- **Precedence, highest first:**
  1. the user's own day override (skip or work anyway);
  2. pause range;
  3. weekend;
  4. company `EXTRA_HOLIDAYS`;
  5. library holiday of a skipping type (the phase-11 filter: `public`, `bank`, `optional`).

  A user override beats a pause on that exact day. A user's explicit choice for a date is more specific than a range.
- **Never throws.** Any read error (the user's overrides, pause, config) degrades to the library-plus-weekend answer, logs once per process with a cooldown, and the decision proceeds. That's old phase 15A's contract, now designed in rather than patched on.
- **One Manila clock.** The module owns the Manila-date and wall-time helpers. Remove the other copies and point every caller here: `isWeekend` and `expectedFireTime` move out of `notifications.ts`, `manilaWallTime` goes, and the duplicate HH:mm formatters go.
- **Callers:** the lifecycle's scheduled-fire and retry paths (phase 15), the missed-run sweep, `dueSlots` (weekend), and `GET /schedule`. Each one asks the gate and keeps no gate logic of its own.
- **Delete the Gazette layer:** `lib/gazette.ts`, `services/gazette.ts`, the 03:00 tick handler and the boot refresh, and `parseProclamations` and its tests. Add a new migration that drops `gazette_holidays`. Keep `holiday_skip_notices`; it's the send-once record.
- `EXTRA_HOLIDAYS` keeps its format and boot validation.

**Tests (unit, `now` injected, no real clock):**
- One test per precedence rule, plus the user-override-beats-pause rule.
- A thrown override read degrades to library plus weekend, with one log line.
- **Regression:** 2026-08-21 (optional) skips, and 2026-08-25 (observance) works.
- Friday → the next workday is Monday. Before a holiday Monday → Tuesday.

**Gate 16A:** `cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration`

---

## 16B — Day overrides: storage and API

**Contract:**
- New table `day_overrides`: `user_id` (FK, cascade on delete), `manila_date` (date), `kind` (`skip` | `work`), optional `note` (text, ≤ 100 chars), `created_at`. Unique on (`user_id`, `manila_date`): one override per day, and setting the other kind replaces it.
- Endpoints under `/schedule`, scoped to `req.user.id` (AGENTS.md rule 5):
  - `GET /schedule/days?from=YYYY-MM-DD&to=YYYY-MM-DD`: for each day in the range (cap it at 92 days), the gate's decision and reason, plus the user's override if any. The calendar renders from this one call. The frontend never re-implements the gate.
  - `PUT /schedule/days/:date` with `{ kind, note? }`, and `DELETE /schedule/days/:date`.
- Reject past dates (Manila today counts as allowed: a same-morning "skip today" before 05:30 is a real use). Validate with zod; return `400` with a message.
- Under the existing `apiLimiter`. Audit-log the set and clear actions (event type only, no note text).
- Update `reference/api-contract.md` and `reference/database-schema.md` in this gate.
- **Changing an override for today cancels a pending retry** for that day when the new decision is "skip" (through the lifecycle).

**Tests (integration):**
- Tenant isolation: user B can't read or change user A's days.
- Set, replace and clear round-trip.
- A past date gives 400.
- `GET /schedule/days` reasons match the gate for a fixture range covering a weekend, a library holiday, a work-anyway holiday, a skip day and a pause.
- A skip set for today cancels today's pending retry.

**Gate 16B:** `cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration`

---

## 16C — The calendar in the Schedule panel (frontend)

**Contract:**
- Add the shadcn **Calendar** (react-day-picker) via the `shadcn` skill. It isn't in `src/components/ui` yet; today's pause dates are plain inputs.
- **A month view in the Schedule panel**, showing:
  - holidays (name on hover or focus, and in the day's detail);
  - the user's skip days and work-anyway days;
  - pause ranges;
  - weekends, muted.

  Use one distinct, accessible style per kind, **never colour alone**: pair colour with an icon or pattern, and give a legend.
- **Selecting a future day** opens a small popover or drawer showing the gate's decision and reason, with actions:
  - "Skip this day" on a workday;
  - "Work this day" on a holiday;
  - "Clear override" when one is set.
- Data via TanStack Query (`useScheduleDays(from, to)`), invalidated on mutation. No `useState` for server data (AGENTS.md rule 12).
- The pause range inputs stay; the calendar displays the range, it doesn't replace it.
- Keyboard: react-day-picker's grid navigation works; the actions are reachable by Tab; focus returns to the day after closing.
- 375 px: the calendar fits without horizontal page scroll.

**Tests:** e2e: mark a holiday "work anyway" and see it reflected after reload; mark a workday "skip" and clear it; run an a11y check on the panel.

**Gate 16C:** `cd app/frontend && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`

---

## 16D — The evening heads-up and skip notices

**Contract:**
- **Every skip notifies**, with the reason ("Skipping today: All Souls' Day (special non-working)" / "Skipping today: your skip day"), once per user per day through `holiday_skip_notices` (rename it `skip_notices` if the coder prefers, in a new migration). Weekends never notify. Muted by `notify_on_skipped`.
- **Heads-up:** after the user's **scheduled clock-out run reaches an outcome** (any status), send one message about the **next workday decision**, for example:
  - *"Next: Mon 05:30 clock-in (tomorrow, Sat, and Sun are weekend)."*
  - *"Tomorrow (Mon 2 Nov) is All Souls' Day, so no clock-in. Next clock-in: Tue 05:30."*
  - *"Tomorrow is a holiday you marked as a workday, so clocking in at 05:30."*

  Each one includes a link to the dashboard (`APP_URL`) so a wrong call can be flipped in the calendar.
- Once per user per day, recorded in the database (no in-memory flag). Fire-and-forget (hard rule 11). On by default; a new toggle `notify_heads_up` in `notification_settings` (migration plus a checkbox in the Notifications panel).
- If the clock-out never ran (missed or paused), no heads-up is sent. The missed-run alert covers that day.

**Tests (integration):** a heads-up is sent once after a clock-out outcome; its text names the next workday across a weekend and a holiday; it is muted by the toggle; a library `public` holiday now sends a skip notice.

**Gate 16D:** `cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration`

---

## Verification Gate (the whole phase)

```
cd app/backend  && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration
cd app/frontend && pnpm lint && pnpm test && pnpm build && pnpm test:e2e
docker compose config 2>&1 | grep -c "is not set"
git grep -n "gazette" -- app/backend/src    # must be empty
```

**`[manual]`: must not be claimed as passed:**

| # | Check | Pass looks like |
|---|---|---|
| 1 | Open the calendar on a phone (375 px) and a desktop | Holidays, weekends and pause visible; legend readable; no sideways scroll |
| 2 | Mark tomorrow "skip" in the evening | The next morning there's no clock-in and you get a "Skipping today: your skip day" message |
| 3 | Mark an upcoming holiday "work anyway" | That morning it clocks in at 05:30 |
| 4 | Receive a heads-up after a real 16:15 clock-out | It names the correct next workday; the link opens the dashboard |
| 5 | The next real library holiday (2026-11-01 is a Sunday; **2026-11-02 All Souls' Day**, a Monday) | Friday's heads-up says Monday is skipped; Monday sends a skip message and no clock-in |

Commit per the loop in `AGENTS.md`. Tag `phase-16-complete` when the table is filled in.

---

> ⚠️ **As-built (2026-10-14).** Gates 16A–16D and the whole-phase Verification Gate are green. Counts at the end of the phase: **271 backend unit / 182 backend integration / 5 frontend unit / 22 e2e** (phase 15 left 262 / 174 / 5 / 16). `docker compose config … | grep -c "is not set"` = **0**; `git grep -n "gazette" -- app/backend/src` is **EMPTY**.
>
> **1. The module is `services/workday.ts`** — it owns the decision *and* every Manila clock helper (`manilaDateString`, `manilaHhmm`, `isWeekend`, `expectedFireTime`, `addManilaDays`, `manilaNoon`, `formatManilaDay`, `isPausedOn`). The copies in `notifications.ts` (`isWeekend`, `expectedFireTime`, `formatManilaDay`), `lib/wall-clock-tick.ts` (`manilaHhmm`), `lib/ph-holidays.ts` (`manilaDateString`, `isPausedOn`) and `services/holidays.ts` (`manilaNoon`/`addDays`) are deleted, and every caller repointed. `services/holidays.ts` survives, reduced to the company layer (library + `EXTRA_HOLIDAYS`). **`formatManilaDay` now uses `day: "numeric"`** so single-digit days read "Mon 2 Nov" as this phase's examples do.
> **2. The `day_overrides` table landed in 16A, not 16B.** 16A's tests ("a user override beats a pause") need the table, so migration `0009_day_overrides.sql` belongs to 16A; 16B adds the API on top of it.
> **3. "Every skip notifies" was implemented LITERALLY — including a pause window.** The bullet names two reasons (a holiday and the user's own skip day) but says "every skip". A paused leave therefore sends one "Skipping today: your pause window" message per would-be clock day, muted by `notify_on_skipped`. **This supersedes phase 7's "a paused day stays silent."** The skip message is muted by `notify_on_skipped` (phase 11 had mapped holiday skips to `notify_on_missed`); this phase is explicit that `notify_on_skipped` is the mute.
> **4. The heads-up ledger is its own table (`heads_up_notices`), not a renamed `holiday_skip_notices`.** This phase offered a rename; `drizzle-kit generate` refuses to run without a TTY the moment a rename is ambiguous ("is this a rename?"), and hand-editing a generated migration is forbidden. `holiday_skip_notices` therefore keeps its name (it now carries every skip) and the heads-up gets its own once-per-day table, also unique on `(user_id, manila_date)`.
> **5. The heads-up fires on ANY terminal clock-out outcome** (success, skipped, failure) — a failed clock-out that will be retried still gets one. A day whose clock-out never ran has no run to finish and therefore gets none, which is this phase's intent. It is once per user per Manila day **in the database**, so the retry case cannot duplicate it.
> **6. NEW CONFIG: `API_RATE_LIMIT` (default 120).** Six new e2e tests drove the suite past the previously hardcoded 120/min **per-IP** `apiLimiter` (one instance shared by `/credentials`, `/schedule`, `/runs`, `/notifications`), and the resulting 429s looked exactly like flakiness — panels rendering "No data for this day". It is now a dial in `config.ts` + `.env.example` + **both** compose files (0 "is not set" warnings preserved), and `e2e-server.mjs` raises it. Production keeps the default; the budget-is-enforced property is still asserted by the integration suite.
> **7. The frontend needed two fixups this phase did not anticipate.** (a) The calendar was added with `pnpm exec shadcn add calendar popover` — the registry ships `import { cn } from "cn"` and an `IconPlaceholder`, which had to be pointed at `@/lib/utils` and `lucide-react`. (b) **`e2e/runs-history.spec.ts` had to be scoped to `[data-testid="runs-panel"]`**: the calendar's grid is a react-day-picker `<table>`, so its bare `tbody tr` locator counted the calendar's five rows too. `@axe-core/playwright` was added as a frontend **devDependency** for the a11y check this phase asks for, and it immediately found two real defects, now fixed: weekend days at `text-muted-foreground/60` (2.29:1) and the holiday cell's destructive-red text on a /10 destructive wash (4.0:1).
> **8. `EXTRA_HOLIDAYS` is pinned in `e2e-server.mjs` to TOMORROW (Manila)** = "E2E Test Holiday", so the calendar e2e has a deterministic holiday to mark as a workday without depending on which real PH holidays fall in the current month.
> **9. The missed-run sweep's `isWorkday` dep kept its NAME but changed meaning:** it is now `(userId, manilaDate) => boolean` and defaults to the gate, so the sweep sees the same per-user decisions the scheduler does (including a user's own "work anyway" on a holiday). A pause is no longer checked separately — it is the gate's second precedence rule.
> **10. Notifications panel:** a fifth checkbox, "Evening heads-up", bound to the new `notify_heads_up` column (`/notifications` `GET`/`PUT` both carry it; the audit metadata records the boolean, never anything else).
> **11. `automation/clock.ts` was touched at ONE line** (its `manilaDateString` import now points at the gate). It was not otherwise edited (AGENTS.md rule 10).
>
> ⚠️ **As-built (found 2026-10-14, B1 fix round).** Review found **B1 (blocking)**: `dueSlots` hard-filtered weekends (`if (isWeekend(manilaDate)) return [];` in `scheduler.ts`), so a weekend "work anyway" override was promised by the calendar/heads-up but never fired by the scheduler, while the per-user missed-run sweep (which *does* ask the gate) saw a work day with no run and sent a false missed alert. **Fix:** `dueSlots` no longer filters weekends — the gate (`decideDay`) owns the work/non-work decision at fire time; `fireCron` asks it and, on a non-work decision, calls `notifySkip` (which refuses weekends via `reason.code === "weekend"`) so a plain weekend stays silent. The heads-up `work_override` branch wording was also corrected (B6) from "a holiday you marked as a workday" to "a day you marked as a workday" (a weekend is not a holiday). Two regression tests prove the fix bites: `test/integration/weekend-gate.test.ts` **5a** (Saturday `work` override → exactly one `in` run, and the sweep sends nothing) and **5b** (plain Saturday → no run, no `holiday_skip_notices` row, no sweep dispatch). Both were proven to go RED when the respective half of the fix was re-introduced. B2 (unused `cn` dependency) was also closed — `cn` removed from `app/frontend/package.json`; only `shadcn@4.12.0` (the CLI) remains, which is pre-existing. **Integration count is now 184** (was 182 at the end of the phase; +2 from `weekend-gate.test.ts`). Unit 271 / frontend unit 5 / e2e 22 unchanged. The fix round did not generate any migration.
