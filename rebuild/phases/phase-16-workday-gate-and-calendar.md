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
