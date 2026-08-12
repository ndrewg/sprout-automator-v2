# Phase 9 — Runs history you can read and reach

**Goal:** fix two defects in the run history — the date is missing, and older runs are unreachable — and put the Gmail-only constraint where people actually read it.

**Depends on phase 8.** Nothing here needs a new config key, but 8A is the prerequisite for the environment as a whole; do not start this with 8A unmerged.

**Attach for this session:** `03-CONVENTIONS-AND-GUARDRAILS.md`, `reference/api-contract.md` (§ `GET /runs` — **this phase changes it, so update it**), `reference/testing-strategy.md`, `phases/phase-3-frontend.md` (§ RunsPanel, for the as-built conventions).

> 📡 **Fetch live docs (Context7):** TanStack Query v5 (`useQuery` with a changing key, `refetchInterval` as a function), Zod (query-param coercion), React 19. Do not write these from memory.

**Skills — all four are installed; use them in their lanes:**
- **`shadcn`** — the authority for shadcn component work (Table, Button, Badge). Do not hand-roll a component the registry already provides.
- **`ui-ux-pro-max`** with **`Platform: Web`** — the responsive and accessibility pass. **Skip its React-Native-only rules** (safe-area, haptics, VoiceOver, native 44pt) and apply the web equivalents.
- **`tailwind-design-system`** — spacing/typography/token consistency. Tailwind v4 is **CSS-first**: no `tailwind.config.js`, no postcss config (AGENTS.md rule 1).
- **`typescript-advanced-types`** — for the `api.ts` response types and the run-status unions. Keep the existing discriminated-union style; do not loosen anything to `any`.

---

## 9A — `GET /runs` returns reachable history

**The defect.** `routes/runs.ts:54` calls `listRuns(req.user.id)`, which has a hard **`.limit(20)`** and accepts no parameters. The UI has no pagination. Runs 21 and older are therefore not paginated — they are **unreachable**, dropped with nothing indicating anything exists beyond the last row. Silent truncation reads as "that's all there is", which is why a growing list became confusing rather than merely long.

**Contract:**
- `GET /runs` accepts an optional `limit` query param. Zod: coerced integer, **min 1, max 100, default 10**. An out-of-range or non-numeric value is a **400 with a validation error**, not a silent clamp — a clamped request lies to the caller about what it returned.
- Response becomes `{ runs, hasMore }`. This is **additive**; `runs` keeps its shape and ordering (newest first), so nothing already consuming it breaks.
- Compute `hasMore` by selecting **`limit + 1`** rows and reporting whether the extra row existed, then returning only `limit`. **Do not issue a second `COUNT(*)`** — it doubles the query cost for a boolean.
- Still scoped to `req.user.id` (AGENTS.md rule 5). Ordering stays `started_at desc`.
- **Update `reference/api-contract.md`.** A stale contract doc is how the next session gets this wrong.

**Tests (integration):**
- No `limit` → at most 10 rows.
- `?limit=25` → up to 25 rows.
- `?limit=0` and `?limit=101` and `?limit=abc` → 400.
- 11 runs at `limit=10` → `hasMore: true`; exactly 10 runs → `hasMore: false`.
- Another user's runs never appear at any `limit` (tenant isolation, re-asserted because the query changed).

**Gate 9A:** `cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration`

---

## 9B — The panel: dates, and a way to see more

**The defect.** `RunsPanel.tsx:33`'s `fmt()` calls `toLocaleTimeString` only. One visible run reads fine; twenty do not — "16:15" says nothing about which day, which is the actual complaint.

### Data layer

- `useRuns(limit)` keyed **`["runs", limit]`**. The panel holds `limit` in `useState`, starting at **10**, growing by **20** per "Show more". That is ephemeral UI state; the rows themselves stay owned by TanStack Query (AGENTS.md rule 12).
- **Do NOT use `useInfiniteQuery`, and this is not a style preference.** `useRuns` polls adaptively — 1500 ms while any run is `pending`/`running`, 5000 ms otherwise. Merged infinite-query pages and a poller interact badly: every tick refetches every page, and appended pages race the refresh. A single query with a growing `limit` refetches as one unit and stays correct under polling.
- **Preserve the existing adaptive `refetchInterval` exactly** — it is load-bearing for live run progress.
- `hasMore` drives whether "Show more" renders at all.

### The row

- Add a **Date** column, rendered as a semantic `<time dateTime={iso}>`:
  - **`Today`** / **`Yesterday`** for the two most recent *local* days.
  - Otherwise `Wed 12 Aug` — weekday short, day numeric, month short. Include the year **only** when it is not the current year.
  - Relative labels are the point: scanning cost is the complaint, and "Today" answers the question at a glance in a way a date never does.
- **`tabular-nums` on the date and both time cells** (ui-ux-pro-max § 6 `number-tabular`). Proportional figures make a time column jitter as digits change, which is most of why a growing list of timestamps reads as disordered.
- Keep `fmt()`'s existing time format. **Do not merge date and time into one cell** — they sort and scan differently.
- **The `Fragment` must keep carrying the `key`, not the inner `<tr>`.** `RunsPanel.tsx:122` documents why; `react/jsx-key` with `checkFragmentShorthand` will fail the build if it moves. This is a bug that already shipped once.

### Show more

- Renders only when `hasMore`.
- Show an honest count — `Showing 10 of 24` or `Showing 30`. A list that silently ends is the defect this phase fixes; do not reintroduce it in the UI.
- Full-width button on mobile, inline on desktop.

### Responsive and accessible

- The table scrolls inside its own **`overflow-x-auto`** wrapper. **The page must never scroll sideways** (ui-ux-pro-max § 5 `horizontal-scroll`, and the skill's Table Handling rule: horizontal-scroll wrapper or card layout).
- The row-expand control has a **≥44 px** touch target (§ 2 `touch-target-size`).
- The expanded step log **wraps**; it must not widen the table.
- Status stays conveyed by text as well as colour (§ 1 `color-not-only`) — the existing badges already do this; don't regress it.

**Tests:**
- *Unit:* the date formatter returns `Today` / `Yesterday` for the correct local days, a weekday+month string otherwise, and includes the year only for a prior year. **The clock must be injected — do not call `Date.now()` inside the formatter.** A formatter that reads the wall clock becomes the next date time-bomb; `missed-run-sweep` already did this to us on 2026-08-11 (`BACKLOG.md` § 11).
- *E2E:* with more runs than the default, "Show more" appends rows and the button disappears at the end.

**Gate 9B:** `cd app/frontend && pnpm lint && pnpm build && pnpm test:e2e`

> ⚠️ **Pre-flight for e2e.** `@playwright/test` is a frontend devDependency but is **not** in the frontend's `pnpm-workspace.yaml` `allowBuilds`, so its browser download is blocked. It works today only because the backend's `playwright install chromium` populated the shared `~/.cache/ms-playwright`. Run `pnpm exec playwright install chromium` before the gate; a missing browser is an environment problem, not a failing test. See `STATE.md` § Known gaps.

---

## 9C — The Gmail-only constraint, where people read it (`BACKLOG.md` § 5)

**The defect.** `lib/imap-otp.ts` hardcodes `imap.gmail.com:993`. That covers Gmail *and* Google Workspace (same host, identical App Passwords) and **nothing else** — anyone whose HRHub codes land in Microsoft 365 cannot use the tool until they forward into a Gmail account. `CredentialsPanel` currently contains **zero** mentions of Workspace or forwarding, so that person's setup fails with no explanation.

**Contract — copy only:**
- Extend the existing Gmail App Password walkthrough in `CredentialsPanel`: the mailbox must be **Gmail or Google Workspace**; if HRHub mails a different provider, set a forwarding rule into a Gmail account and use that address here.
- Near the notification settings, state: **a missed-run alert means "the automation didn't run", not "you aren't clocked in"** — someone who clocked in by hand still gets one. Without that sentence people either panic or learn to ignore alerts, and an ignored alert is worse than none.
- **No new dependency, no layout rewrite, no component extraction.** Follow the panel's existing markup conventions. **Do not introduce a clickable link containing a token** — a dead `bot<TOKEN>` link was already removed from `NotificationsPanel` for exactly this reason.

**`[manual]`, not code:** the onboarding one-pager (what it does, what it stores and how it's encrypted, the ~5-minute setup, what the notifications mean, and that it clocks *you* in under *your* credentials so accuracy stays your responsibility). Human deliverable, listed so it is not forgotten.

**Gate 9C:** `cd app/frontend && pnpm lint && pnpm build`

---

## Verification Gate (the whole phase)

```
cd app/backend  && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration
cd app/frontend && pnpm lint && pnpm build && pnpm exec playwright install chromium && pnpm test:e2e
```

**`[manual]` — must not be claimed as passed:**

| # | Check | Pass looks like |
|---|---|---|
| 1 | Runs panel with >10 runs — read the dates | Two most recent days read `Today`/`Yesterday`; older rows `Wed 12 Aug`; no ambiguity about which day a run belongs to |
| 2 | Click **Show more** | Rows append, the count stays honest, the button disappears at the end |
| 3 | Click **Show more**, then watch during a live run (1.5 s poll) | Rows keep refreshing and the expanded set does **not** collapse back to 10 |
| 4 | Runs panel at 375 px, expand a row | The **table** scrolls sideways, the **page** does not; the step log wraps; the expand control is comfortably tappable |
| 5 | Read the new `CredentialsPanel` copy as someone who has never set this up | It is obvious the mailbox must be Google, and what to do if it isn't |

Commit per the loop in `AGENTS.md`. Tag `phase-9-complete` when the `[manual]` rows are filled in.
