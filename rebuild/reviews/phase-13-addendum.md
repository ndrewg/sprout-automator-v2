# Phase 13 — Holiday sourcing: tester addendum

**Tester session:** 2026-08-24  
**Adversarial findings against the coder's Handoff report**

---

## A. Gate re-run results (verbatim)

### Backend

```
$ cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration
  Test Files  20 passed (20)
      Tests  207 passed (207)
   Duration  1.18s (transform 909ms, setup 0ms, import 3.02s, tests 622ms, environment 2ms)

  Test Files  25 passed (25)
      Tests  135 passed (135)
   Duration  31.31s (transform 362ms, setup 0ms, import 17.25s, tests 11.50s, environment 1ms)
```

**207 unit ✅ 135 integration ✅** — both above baseline (161/106), no regressions.

### Docker compose

```
$ docker compose config 2>&1 | grep -c "is not set"
0
```

**`is not set` = 0 ✅** — `EXTRA_HOLIDAYS` passes through as `${EXTRA_HOLIDAYS:-}` in both compose files.

### Drizzle-kit check

```
$ npx drizzle-kit check
Everything's fine 🐶🔥
```

**✅** — migration `0006_gazette_holidays.sql` matches the schema; no committed migrations edited.

### Frontend (unreported by coder — added by tester)

```
$ cd app/frontend && pnpm lint && pnpm test && pnpm build
  Test Files  1 passed (1)
      Tests  5 passed (5)
✓ built in 165ms

$ pnpm test:e2e
  Running 16 tests using 8 workers
  16 passed (9.5s)
```

**5 frontend unit ✅ 16 e2e ✅** — no regressions from the async route change.

---

## B. Findings

### B1. `renderPossibleHolidayMessage` has no unit test (non-blocking)

**Evidence:** `test/services/notifications.test.ts` has no test for `renderPossibleHolidayMessage`. The function is only exercised through the integration test (`holiday-sourcing.test.ts:212` "notifies a POSSIBLE holiday without skipping"). Its HTML rendering (escapeHtml of name, formatManilaDay, message template) is verified only indirectly through the dispatch path.

**Impact:** Low — the integration test does exercise the full render → dispatch → send path. But the pure rendering contract (what the Telegram message looks like, correct escaping, correct source naming) is not independently asserted. A future refactoring of the message template would only be caught by e2e, not by a targeted unit test.

**Suggested fix:** Add a `renderPossibleHolidayMessage` describe block in `notifications.test.ts` with at least: (a) correct output for a gazette regional entry, (b) HTML escaping of the name.

### B2. `.gitignore` unreported change in working tree (non-blocking)

**Evidence:** `git diff` shows `.gitignore` modified with `+logs_86137047854/` added. The committed version (HEAD) does NOT contain this line — `git show HEAD:.gitignore` has no `logs_86137047854` match. The directory exists on disk. This change was not listed in the Handoff report's "What I changed" section.

**Impact:** Low — it's a stray artifact from a prior session, not phase 13 code. But it IS in the uncommitted diff and will show up in the reviewer's `git diff`. The reviewer should either stage it deliberately or revert it; it should not be left as unreported noise.

**Suggested fix:** The reviewer should decide: either stage the `.gitignore` change in the phase-13 commit (since it's protective — prevents accidental staging of logs) or revert it with `git checkout -- .gitignore` and leave the directory untracked.

### B3. `test/integration/harness.ts` change not in Handoff report (non-blocking)

**Evidence:** The harness TRUNCATE statement was updated to include `gazette_holidays` in the table list. This is necessary for integration test isolation (the new table must be cleared between tests). The change is +1/-1 line. Not listed in the Handoff report's "What I changed."

**Impact:** None — the change is correct and necessary. Documentation gap only.

### B4. `namesMatch` threshold tuned for Eid; single-token holiday names won't trigger disagreement (design observation, non-blocking)

**Evidence:** `services/holidays.ts:162-169` uses a shared-token threshold of `>= 2`. The Eid payoff case works: "End of Ramadan (Eid al-Fitr)" tokenises to {end, ramadan, eid, fitr} and "Eid'l Fitr" to {eid, fitr} — 2 shared tokens. However, a holiday name like "Rizal Day" tokenises to {rizal} (after removing stopword "day"), so a gazette/Library disagreement on Rizal Day's date would NOT be flagged by the automated disagreement note.

**Impact:** Very low — fixed-date holidays (Rizal Day, Christmas, etc.) are astronomically unlikely to have date disagreements between the library and the Gazette. The feature's primary payoff is Eid (lunar holidays), where the threshold works. This is a known design tradeoff, not a defect.

**No fix required** — but a comment in `namesMatch` noting the Eid-specific tuning would help future readers.

### B5. Claims that held under adversarial probing

| Claim from Handoff report | Verdict | How verified |
|---|---|---|
| `parseExtraHolidays` refuses malformed entries at boot | ✅ Held | Direct exec: `EXTRA_HOLIDAYS=2026-02-31=Nope` → BOOT REFUSED with entry name + fix |
| Additive-only: gazette can never cancel library/override skip | ✅ Held | Integration test `holiday-sourcing.test.ts:98-109` seeds ambiguous gazette on library holiday date; library skip preserved |
| Cache-first: no network at decision time | ✅ Held | `loadGazetteForDate` is a pure DB read (`db.select().from(gazetteHolidays).where(...)`) — no fetch call in the decision path |
| Fetch failure keeps previous cache, doesn't affect runs | ✅ Held | Integration test `holiday-sourcing.test.ts:248-282` seeds cache, calls refreshGazetteCache with throwing fetch, asserts cache intact and decision resolves normally |
| Override always notifies, wins over library | ✅ Held | Integration tests `holiday-sourcing.test.ts:138-154` and `:181-195` |
| Gazette national → skip+notify; regional/ambiguous → notify only | ✅ Held | Integration tests `holiday-sourcing.test.ts:68-96` |
| Eid disagreement produces skip on gazette date + disagreementNote | ✅ Held | Integration test `holiday-sourcing.test.ts:123-136`; also verified `namesMatch` tokenization by hand: library {end,ramadan,eid,fitr} vs gazette {eid,fitr} → 2 shared ≥ 2 ✅ |
| `public` library holiday → silent; override/gazette/optional → notify | ✅ Held | `notifications.ts:324`: `if (holiday.type !== "optional" && holiday.source === "library") return "skipped"` — only public library is silent |
| Async route properly awaits orchestrator | ✅ Held | `schedule.ts:37`: `const decision = await resolveHolidayDecision(now)`; route handler: `res.json({ schedule: await toView(row) })` — all properly awaited; e2e suite green confirms no regression |
| Locality: national NEVER inferred from absence of qualifier | ✅ Held | `gazette.ts:132-138`: `classifyScope` returns "ambiguous" for bare titles; test `gazette.test.ts:46-52` asserts "DECLARING JANUARY 2 AS A SPECIAL DAY" → "ambiguous" |
| No new npm dependency | ✅ Held | `package.json` unchanged; `gazette.ts` has zero imports — pure regex + built-in fetch |
| `date-holidays` only in `ph-holidays.ts` | ✅ Held | grep: exactly 1 match in `src/lib/ph-holidays.ts` |
| `isWorkday` async-capable and awaited in sweep | ✅ Held | `notifications.ts:370`: `isWorkday: (date: Date) => boolean \| Promise<boolean>`; `:479`: `if (!(await deps.isWorkday(now))) return;` |
| idempotent holiday skip notice (one per user per Manila day) | ✅ Held | `holiday_skip_notices` unique on `(user_id, manila_date)`; `onConflictDoNothing` in `notifyHolidaySkip`; test covers double-fire suppression |
| Config EXTRA_HOLIDAYS emptyToUndefined works for compose | ✅ Held | config test: `process.env["EXTRA_HOLIDAYS"] = ""` → `loadConfig().EXTRA_HOLIDAYS` is `undefined` |

---

## C. What I could not verify (human-only)

These are the 5 `[manual]` rows from the phase file, plus the dev-DB migration and the live Gazette limitation:

| # | Check | Why I cannot verify |
|---|---|---|
| 1 | Set `EXTRA_HOLIDAYS` to tomorrow, wait for the clock-in cron fire → skipped + Telegram names the override | Needs a running container with a real Telegram bot and a real schedule; the cron must actually fire |
| 2 | Set `EXTRA_HOLIDAYS=2026-02-31=Nope`, restart → refuses to boot naming the entry | **I verified this locally (see B5 table above)** — it REFUSES to boot. The [manual] row asks for a container restart, which I cannot do in this session. My local exec confirms the code path works. |
| 3 | A real proclamation day, after 13B ships → skipped + Telegram names the proclamation | **Cannot verify**: the Gazette parser's regex against LIVE officialgazette.gov.ph markup is untested. The hardcoded URL (`https://www.officialgazette.gov.ph/`) plus regex is structurally correct and fixture-tested, but whether the actual page structure matches the regex's assumptions is a [manual] check. The URL is likely NOT the correct proclamation endpoint — the Gazette site has evolved, and the parser may need endpoint + regex tuning. **This is the single biggest unknown in the phase.** |
| 4 | Block outbound access to the Gazette → run completes normally + one log line about the failed fetch | Needs a running container with outbound access blocked (firewall rule or iptables); the test proves the code path but the [manual] row asks for a live verification |
| 5 | Next Eid → the proclaimed date is the one that skips | **Cannot verify until the next Eid proclamation is published** — this is a future event. The test with fixture data proves the disagreement mechanism works. |
| Dev DB | Apply migration `0006_gazette_holidays.sql` to the dev `sprout` database | `drizzle-kit check` passes, but the dev DB needs `pnpm exec tsx --env-file=../../.env src/db/migrate.ts` run manually |

### Gazette live-URL limitation (important — document for the human)

The Gazette parser (`lib/gazette.ts`) uses:
- **URL:** `https://www.officialgazette.gov.ph/` (site root, hardcoded)
- **Parser:** regex over HTML-stripped text, looking for `\b(\d{4})-(\d{1,2})-(\d{1,2})\b` date patterns

**What is proven:** The regex correctly extracts dates and classifies scope from fixture HTML. The injectable `fetchFn` is tested with a fixture transport. The `onConflictDoUpdate` upsert logic is correct.

**What is NOT proven:** Whether the live Gazette site actually contains date+title pairs in the format the regex expects. The Gazette site has evolved over the years, and the proclamation listing page may use a different structure (e.g., JavaScript-rendered content, API endpoints, PDF links instead of HTML dates). The hardcoded root URL is almost certainly NOT the correct proclamation listing endpoint — the Gazette typically publishes proclamation listings at paths like `/nationwide/` or `/proclamations/`, not the site root.

**This is a known limitation, not a code defect.** The code is structurally sound and will gracefully degrade (empty cache → library-only behavior). But the `[manual]` row 3 is where the human validates whether the parser actually extracts real proclamations from the live site, and row 5 is where the Eid payoff is confirmed.

**Recommendation:** Before the next Eid proclamation, the human should:
1. Visit `https://www.officialgazette.gov.ph/` and check if proclamation listings are visible as HTML text
2. If not, identify the correct proclamation endpoint and update `GAZETTE_URL` in `lib/gazette.ts`
3. Test the parser against a real proclamation page's HTML

---

## D. Verdict

**Clean to commit.** No blocking findings. The five non-blocking findings (B1–B4) are:
- B1: missing unit test for `renderPossibleHolidayMessage` (add if convenient)
- B2: unreported `.gitignore` change (reviewer decides: stage or revert)
- B3: unreported `harness.ts` change (documentation gap only)
- B4: `namesMatch` threshold observation (design tradeoff, not a defect)

All automated gates pass (207/135/5/16), all core invariants verified, module ownership clean, no committed migrations edited, no secrets leaked, async route properly handled. The `[manual]` 5-row table + dev DB migration are the remaining items before tagging.
