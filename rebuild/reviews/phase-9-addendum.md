# Tester addendum — phase 9 runs-history

**Phase 9 is uncommitted (working tree = `77bed43` + phase 9).** The diff I tested is exactly the implementer's 13 modified + 7 new files, confirmed byte-identical after every probe (git blob `dad164d` for `services/runs.ts`; every other file verified line-for-line and re-verified by re-running all gates green).

**Verdict up front:** gates re-ran green at the exact claimed counts; every new test was proven able to fail; the two high-risk behaviors (date locality, poller-vs-expanded-set) verified live and correct. **No BLOCKING findings.** One **MAJOR** finding (F1, CI claim is false), two **MEDIUM** (F2 seed-helper footgun, F3 contract under-documents strictness), one **PRE-EXISTING** a11y gap (F4).

---

## A. What I verified structurally (file:line)

### Gates — re-ran from scratch, counts match the report
- `app/backend`: lint ✅, typecheck ✅, `pnpm test` → **16 files / 161 tests**, `pnpm test:integration` → **20 files / 106 tests** (incl. the 5 runs-history tests).
- `app/frontend`: lint ✅, `pnpm test` → **1 file / 5 tests** (vitest 4.1.10), `pnpm build` ✅, `pnpm test:e2e` → **16 passed** incl. the 2 runs-history runs (desktop + mobile). Postgres was up (`sprout-postgres` healthy) before the integration/e2e suites.

### 9A — route + service
- `src/routes/runs.ts:21-23` — `listQuerySchema` is `z.object({ limit: z.coerce.number().int().min(1).max(100).default(10) }).strict()`; route `:60-64` responds `{ runs, hasMore }` and 400s with `{ error: "Invalid input", details }` on parse failure. Matches spec exactly.
- `src/services/runs.ts:209-220` — `listRuns(userId, limit)` selects `.limit(limit + 1)`, `hasMore = rows.length > limit`, returns `rows.slice(0, limit)`. **No `COUNT(*)`** — the only `COUNT(` in `src/` is a comment (`services/runs.ts:207`). SQL plan confirmed via `EXPLAIN` on the live DB: plain `LIMIT 101` + `Seq Scan … Filter: (user_id = …)`, no aggregate.
- `GET /runs` unauthenticated → **401** `{"error":"Not authenticated"}` (verified via curl).

### 9B — panel + hooks + dates
- `src/hooks/useRuns.ts:14` — `queryKey: ["runs", limit]`; `:17-23` adaptive `refetchInterval` — body **logically byte-identical** to pre-phase (only the data accessor changed `data` → `data?.runs`). **No `useInfiniteQuery`.** Mutations `useStartRun`/`useSubmitOtp` still `invalidateQueries({ queryKey: ["runs"] })` (`:31, :40`) — v5 prefix matching covers `["runs", limit]`.
- `RunsPanel.tsx:140` — **the `Fragment` carries `key={run.id}`**, not the inner `<tr>`. Guard proven live: moving the key to the `<tr>` → `oxlint` fails `react(jsx-key): Missing "key" prop`, restore → passes. `:174` — detail row `colSpan={6}` (header grew from 5 to 6 columns). OTP paste bridge (`:80-104`) is byte-identical to the committed version. Step-log rows now `flex flex-wrap` + `min-w-0` (`:196, :201`). Status is text in a Badge (`:155-157`), never colour-only. Rows are `py-3` (`:145+`).
- `src/lib/dates.ts:11-43` — injected `now`, local-day arithmetic via `getFullYear/getMonth/getDate` on both dates, `Math.round` for DST, year only when `date.getFullYear() !== now.getFullYear()`, output assembled from `formatToParts`.

### Tooling / supply chain
- `package.json` — `vitest ^4.1.10` added as a **devDependency**; `"test": "vitest run"`. Backend `package.json` untouched (`vitest ^2.1.0` still), backend lockfile untouched.
- `pnpm-lock.yaml` diff is **exclusively vitest 4.1.10 + its transitives** (`@vitest/*`, `chai`, `tinyrainbow`, `pathe`, `siginfo`, `why-is-node-running`, etc.) — nothing else changed (read the full 247-line diff).
- `app/frontend/pnpm-workspace.yaml` — `allowBuilds` unchanged (esbuild, `@tailwindcss/oxide`); vitest needs no postinstall (its install works, tests run). `minimumReleaseAge: 1440` still set; the install resolved and the lockfile committed fine, so the constraint was respected.
- `vitest.config.ts` — alias `@` → `./src`, `include: ["src/**/*.test.{ts,tsx}"]`, no jsdom.

### 9C copy
- `CredentialsPanel.tsx` — card description + a `<p>` in the App Password walkthrough stating Gmail/Google Workspace-only and the forwarding fallback; `NotificationsPanel.tsx` — `FieldDescription` with the exact missed-run sentence. **No links added at all** (nothing token-bearing). Both rendered live in the browser.

---

## B. Findings

### F1 — MAJOR. The "no CI file exists" claim is false; the new frontend unit tests are not CI-gated.
`.github/workflows/ci.yml` **exists and is tracked** (created in phase 0, `2aa6559`; phase L, `4323518`, added `pnpm lint` to both jobs). Its `frontend` job runs `pnpm lint` and `pnpm build` but **not `pnpm test`**. The report's divergence note ("No `.github/workflows` exists in this repo, so there was no CI file to add the new frontend `pnpm test` to") and the identical sentence in the `phase-9-runs-history.md` 9B as-built note are both **factually wrong**.

Concrete failure scenario: someone regresses `dates.ts` (e.g. reintroduces a wall-clock read). Locally `pnpm test` goes red, but if the work lands via a PR/push where CI is the gate, the 5 date-formatter unit tests never run — CI is still green and the regression ships. The phase *added* a test runner specifically to gate this; it is not wired into the gate that runs on every push.

Fix: add `- run: pnpm test` to the frontend job (a one-line change; vitest runs with no DB). Correct the false claim in the report and the phase file. Not in the task's BLOCKING list (no broken product behavior), but I recommend fixing before commit — the report's justification for skipping it is simply wrong.

### F2 — MEDIUM. `app/backend/test/e2e-seed-runs.ts` has no guard against a non-test database.
The helper imports `db` from `../src/db/client` and `INSERT`s runs with **no check that `DATABASE_URL` points at `sprout_test`** (`e2e-seed-runs.ts:1-34`). Only the *call site* pins the database: `e2e/runs-history.spec.ts:34-38` sets `DATABASE_URL` to `…sprout_test`. Anyone running `pnpm exec tsx test/e2e-seed-runs.ts <userId> <count>` with a dev/prod `DATABASE_URL` in their shell would **fabricate run history in the real `sprout` database** — 40 rows of fake "success" runs for an arbitrary user id, visible in their history panel and counted by the missed-run sweep.

`spawnSync(…, { shell: true })` itself is fine here: the arguments are a server-generated UUID (from `/auth/me`) and `String(SEED_COUNT)` — a numeric constant (`runs-history.spec.ts:25-42`). No injection surface; the DEP0190 warning is pre-existing (also emitted by `e2e-server.mjs`). The finding is the missing DB-name guard, not the shell flag.

Fix options: assert the database name contains `test` before inserting, or require an explicit `NODE_ENV === "test"` / `E2E_SEED=1` opt-in. Low cost; recommend before or right after commit (a footgun, not a shipped bug).

### F3 — MINOR. `reference/api-contract.md` under-documents the route's strictness.
The rewritten `GET /runs` section (`api-contract.md:126-130`) documents `limit` and the 400-on-invalid contract but does **not** state the schema is `.strict()`, so an unknown query param (e.g. `?limit=10&bogus=1`) 400s — which I verified live and which the contract doesn't promise. The contract doesn't *contradict* the route; it understates it. I confirmed the frontend never appends another param (`api.ts:128-131` sends only `?limit=`), so no functional impact. One sentence in the contract would close the gap.

### F4 — PRE-EXISTING (not a phase-9 regression). The row-expand control is not keyboard-reachable.
The whole `<tr>` is the expand target (`RunsPanel.tsx:141-144`) with `onClick` and **no `tabindex`/`role`**. Verified live: 10 clickable rows, 0 focusable; Tab from "Show more" jumps straight to `BODY`. This was **already so before the diff** — the committed version had the identical `<tr onClick>` (confirmed via `git show 77bed43`), and phase 9 only changed `py-2` → `py-3`. So it is not a phase-9 regression. It is, however, a gap against ui-ux-pro-max § 1 (keyboard-nav / focus-states) that the phase's spec pointed at for this exact control — the phase achieved the ≥44 px touch target (measured 65 px) but left keyboard nav broken. Recommend a follow-up: `tabIndex={0}` + `role="button"` + Enter/Space handler (or a real button in the first cell).

### Not-a-finding, deliberately recorded: `?limit=1e2` returns 200, not 400.
The task's probe list said `1e2` must 400. It does not, and correctly so: `z.coerce.number()` runs `Number("1e2")` → `100`, which is numeric, an integer, and inside 1–100 — the contract's words are "out-of-range or non-numeric → 400", and 100 is neither. It is a faithful coercion of scientific notation, **not** a silent clamp. Verified live: `runs=25, hasMore=false` for a user with 25 runs (identical to `?limit=100`).

### The report's own caveats, re-checked
- "Showing N (not N of M)": correct and unavoidable — the `{ runs, hasMore }` contract returns no total; panel shows `Showing {runs.length}` + button when `hasMore` (`RunsPanel.tsx:220-232`). Honest and monotonic as claimed.
- `1e2`-type edge cases, empty `?limit=` → 400, duplicate `?limit=10&limit=20` → 400, unknown param → 400 — all verified live via curl (details in § E).

---

## C. What I could not verify

- **OTP paste bridge end-to-end.** The bridge itself is structurally unchanged (byte-identical to the committed version; the alert renders when a run is waiting) and the `waitingForOtp` flag is server-side state (`routes/runs.ts:35`, `isRunWaitingForOtp(run.id)`) I could not reproduce without a real or mockable OTP-acquisition flow. I could not type a code into the box against a genuinely waiting run. **The one control in this panel with a real deadline** — a human with a live HRHub run should confirm it still accepts a code.
- **Whether CI actually runs.** The repo may or may not be on GitHub with Actions enabled. If CI is dead, F1 has no operational impact today — but the claim "no CI file exists" is false either way, and the ledger should not say it.
- **Real HRHub / Telegram / live scheduled runs.** Everything automated is against `sprout_test` with a dead `SPROUT_URL`.
- **Visual/readability judgment** of the new copy and the dates at a glance (assigned to the human in § D).
- **`hasMore` under data churn during a poll.** I proved stability under a *sustained* fast poll (12 s with a live `running` row) and under mutation invalidation; I did not specifically prove the exact-10/11 boundary *while polling*, but that is server-side and covered by the integration tests.
- **Query `1e2` behaviour at the exact 100/101 boundary combined with hasMore** — covered piecewise (100/101 and 1e2 both verified); not the combination.

---

## D. What only a human can check — `[manual]`

Results column intentionally empty.

| # | Check | Exact click sequence | Pass looks like |
|---|---|---|---|
| 1 | Dates read correctly with >10 runs | Log in → Runs panel has >10 runs → read the Date column | Two most recent *local* days read `Today`/`Yesterday`; older rows `Wed 12 Aug`; a row from a prior year carries the year; no ambiguity which day a run belongs to. Try at a Manila-locale browser AND one in UTC+0 to see the labels follow the browser's local day |
| 2 | Show more | Click **Show more** twice with ≥40 runs | Rows append (10 → 30 → 40), `Showing N` stays honest, the button disappears after the last row |
| 3 | Show more survives a live run's 1.5 s poll | With ≥40 runs, click **Show more** (30 rows), then **Clock in now** | The new run appears at the top, the table keeps refreshing, and the set **does not collapse back to 10** (I verified this against a seeded `running` row; confirm with a real run) |
| 4 | 375 px expand | DevTools → 375×812 → expand any row | The **table** scrolls sideways inside its own wrapper, the **page** does not; the step log wraps; the row is comfortably tappable (measured 65 px here) |
| 5 | CredentialsPanel copy as a first-timer | Gmail card → **How do I set this up?** | It is obvious the mailbox must be Google/Workspace, and what to do if HRHub mails another provider |
| 6 | OTP paste bridge still accepts a code | During a real run that reaches the OTP step, type the code into the box → **Submit OTP** | Code is accepted and the run proceeds. This is the fallback with a real deadline behind it — structurally untouched, but only a live run proves it |
| 7 | Onboarding one-pager (9C) | — | The human deliverable (§ 9C `[manual]`) exists: what it does, what it stores/how encrypted, ~5-min setup, what the notifications mean, and that it clocks *you* in under *your* credentials |
| 8 | CI question | Check whether this repo's GitHub has Actions enabled | If yes, F1 must be fixed (add `pnpm test` to the frontend job) before the commit; if the repo never runs CI, F1 is a ledger-correction only |

---

## E. Live probe evidence (for the reviewer)

All against a real backend on `sprout_test` (ephemeral server, `SIGNUP_ALLOWED=example.com`, `AUTH_RATE_LIMIT=100`, dead `SPROUT_URL`).

**Contract (curl, two real accounts A and B):**
```
A no-limit            runs=0   hasMore=False   (B held 25)
A ?limit=10/25/100    runs=0   hasMore=False   (tenant isolation, all limits)
limit=0      -> 400 Invalid input (min 1)
limit=101    -> 400 Invalid input (max 100)
limit=abc    -> 400 Invalid input (received nan)
limit=-3     -> 400 Invalid input (min 1)
limit=10.5   -> 400 Invalid input (Expected integer, received float)
limit=1e2    -> 200, runs=25, hasMore=False   (Number("1e2")=100; in-range — not a clamp)
limit= (empty)   -> 400 Invalid input (Number("")=0 < 1)
limit=10&limit=20 -> 400 Invalid input (received nan — duplicate rejected)
?limit=10&bogus=1 -> 400 "Unrecognized key(s) in object: 'bogus'" (.strict())
GET /runs unauth  -> 401
```
**hasMore boundaries (live):** exactly 10 runs → false; 11 → true; 25 @ limit=25 → false; 101 runs @ limit=100 → true. Newest-first confirmed. SQL plan: `Limit` on `Sort … Seq Scan … Filter: user_id` — no `COUNT`.

**Poller / invalidation (browser, real app):** seeded 40 runs → `Showing 10` → Show more → `Showing 30` → **Clock in now** → new run appears at top, count stays 30 (invalidation refreshes `["runs", 30]` without reset) → seeded a `running` row → watched 12 s of 1500 ms polling → still `Showing 30`, running row live, expanded detail intact. **No collapse.**

**Dates (direct probe, injected clock):** 23:59 prev-day / 00:01 next-day → Yesterday; 00:30 same-day / noon → Today; 08:30 same day → Today; prior year → `Wed 13 Aug 2025`; far-past injected now → Today (proves no `Date.now()`); same-UTC-day-but-+8-local-crossed → Today.

**Fault probes (break → red → restore → green):**
- Backend integration (5): `desc`→`asc` broke ordering (4/5 red); `limit(limit+1)`→`limit(limit)` broke hasMore (3/5 red); schema `max(100)`→`max(200)` broke the 400-contract (1/5 red, `expected 200 to be 400`); removing `.where(userId)` broke tenant isolation (2/5 red). All restored, 5/5 green, file blob `dad164d` identical.
- Frontend unit (5): Today string, Yesterday string, part-assembly order, year-always, and wall-clock (`new Date()` for `now`) each broke exactly their test; the wall-clock probe failed with `expected 'Wed 15 Jan' to be 'Today'` — the exact failure the "does not call Date.now()" test exists to catch. Restored, 5/5 green.
- E2E: `INITIAL_LIMIT = 100` (panel renders everything at once) → spec failed on **both** projects at `Showing 10` — the false-pass it guards against is real. Restored, 2/2 green.
- Fragment-key lint guard: key moved to inner `<tr>` → `pnpm lint` fails `react(jsx-key)`; restore → passes.

The working tree at hand-off is the implementer's phase-9 state exactly (byte-verified); the tester's scratch artifacts (`.playwright-mcp/`, injected rows, scratch server) were removed.

---

# Round 2 — review-correction round (the tester's F1–F3)

**Scope of this round.** Only the reviewer's four fixes were touched: `.github/workflows/ci.yml` (+`pnpm test` to the frontend job), the `phase-9-runs-history.md` 9B as-built correction, `reference/api-contract.md` (the `.strict()` sentence), `app/backend/test/e2e-seed-runs.ts` (the DB-name guard), and the `STATE.md` ledger note. Everything else in the working tree is round 1's state, unchanged. **Round 1's live behaviour probes were NOT repeated** — only the light regression in § 6 below.

## A. Verified structurally (file:line)

### Gates — re-ran from scratch, counts match
- `app/backend`: `pnpm lint` ✅, `pnpm typecheck` ✅, `pnpm test` → **16 files / 161 tests**, `pnpm test:integration` → **20 files / 106 tests**.
- `app/frontend`: `pnpm lint` ✅, `pnpm test` → **1 file / 5 tests**, `pnpm build` ✅, `pnpm test:e2e` → **16 passed** incl. runs-history on desktop **and** mobile.
- `pnpm install --frozen-lockfile` (app/frontend) → `Already up to date`, exit 0.

### F1a — the CI edit parses and is positioned correctly
- `ci.yml:27` — `- run: pnpm test` sits in the **frontend** job between `pnpm lint` (`:26`) and `pnpm build` (`:28`), i.e. after `pnpm install --frozen-lockfile` (`:25`). The `git diff` vs the committed file is **exactly one added line** (blob diff: `+      - run: pnpm test          # vitest (the src/**/*.test.ts/tsx unit tests)`), nothing else moved.
- YAML parses: `yaml.safe_load` on `.github/workflows/ci.yml` → `parsed OK`; frontend steps resolve to `install --frozen-lockfile → lint → test → build`.
- Backend job untouched: its steps remain `install --frozen-lockfile → lint → typecheck → test → audit` (`ci.yml:12-16`) — it already ran its own `pnpm test`.
- **Coverage fact for the ledger (not a defect to fix here):** `pnpm test:integration` and `pnpm test:e2e` run **nowhere in CI** for either package. The backend job stops at unit `test`; the frontend job has no e2e. CI is a typecheck + lint + unit-test gate only.

### F1b — the correction's substance is right; **its commit citation is wrong**
- The correction (`phase-9-runs-history.md:86`) replaces the false claim with: "`.github/workflows/ci.yml` exists and is tracked (committed in phase L, `4323518`)". The **existence and tracking** claims are true, and "its `frontend` job ran only `pnpm lint` + `pnpm build`" was true **at** `4323518`.
- But `git show --stat 4323518` shows ci.yml as **`2 +` (modified), not created**. The file was first committed in **`2aa6559`** (`feat(phase-0): typescript scaffold + health + compose`), which already contained a frontend job (`pnpm build` only). `4323518` (phase-L) added the two `pnpm lint` lines to both jobs. So "committed in phase L, `4323518`" is wrong provenance — it should cite `2aa6559` (phase 0), with `4323518` as the commit that added linting. The wrong citation was copied from round 1's own F1 finding (`phase-9-addendum.md:39`), which said the same thing.
- The **false claim itself** ("no `.github/workflows` exists") appears nowhere in the phase file, `STATE.md`, or `api-contract.md` — the only remaining mentions are in this addendum, which is the historical record of the finding, not a live claim.

### F3 — the contract now matches the code
- `routes/runs.ts:21-23` — `listQuerySchema` is `z.object({ limit: … }).strict()`.
- `routes/runs.ts:60-66` — a failed parse → `400 { "error": "Invalid input", "details": … }`; exactly what `api-contract.md:129` now promises ("any unknown query key … also → 400 …"). The route file is byte-unchanged since round 1 (mtime 8/13, live 400-on-`bogus=1` verified in round 1 § E), so the round-1 live evidence stands.

### F2 — the guard works and is positioned correctly; the substring rule is looser than it reads
- Guard **before any INSERT**: `e2e-seed-runs.ts:27-35` runs `select current_database()`, throws if the name lacks `test`; the `db.insert` is at `:39`. Exit path is the sanctioned `main().catch` → `console.error` + `process.exit(1)` (`:54-56`).
- **Refusal against the real dev DB** (probe, `sprout`): exit **1**, error `refusing to seed: connected database "sprout" is not a test database (name must contain "test")`, and **zero rows written** — `runs` count in `sprout` was **13 before, 13 after**.
- **Legitimate path still works** (probe, `sprout_test`, real user `2140ea8b…`): exit **0**, 1 row landed (count 0→1 for that user), then **deleted by exact id** (DELETE 1, count back to 0). The e2e runs-history spec (which drives the helper through the same `spawnSync`) passes on both projects — the guard does not block the real call site.
- **Substring rule probed, not just reasoned:** created a throwaway database named **`latest`** (contains the substring `test`), copied the `sprout_test` schema into it, inserted a valid user, ran the helper → exit **0**, and **3 rows were written** into `latest`. So the guard is **not as tight as it reads**: *any* database whose name contains `test` passes, e.g. `latest`, `contest`, `sprout_prototype`. **Judged against the deployment:** the actual dev/prod database is `sprout` (no `test` → refused ✓); the guard's job is to stop a bare invocation with a dev/prod `DATABASE_URL` from fabricating history, and it does that for the real database name. The bypass requires a non-test DB whose name *happens to contain* `test` — an exotic name, and the helper is test-only. **Not a blocker**, but the "must contain test" wording implies a tight rule it isn't; `sprout_contest`-style names would slip through. One line to tighten (e.g. reject unless the name is exactly `sprout_test` or ends `_test`). Flagging explicitly per the task.

### Round-2 diff scope
- `services/runs.ts` blob is `dad164d` — byte-identical to the round-1 record. All other round-1 files' mtimes are 8/13; **only** ci.yml, the phase file, api-contract.md, e2e-seed-runs.ts and STATE.md have 8/14 mtimes. `sprout_test` was left as found (probe row removed; the pre-existing 82-row base is the e2e suites' own fixture data).

## B. Findings (Round 2)

### F1b — MEDIUM (doc provenance, the correction's own citation is wrong). 
The review correction in `phase-9-runs-history.md:86` correctly retracts the false "no CI" claim but attributes the file to the wrong commit: `4323518` (phase-L) only **added `pnpm lint`** to the two jobs; `.github/workflows/ci.yml` was **created in `2aa6559` (phase 0)**. A correction that cites the wrong commit is the same failure in a new coat — the next session reading "committed in phase L, `4323518`" gets a false origin. **Fix:** change the parenthetical to "created in phase 0, `2aa6559`; phase L (`4323518`) added `pnpm lint` to both jobs". Also correct `phase-9-addendum.md:39`'s identical wrong citation so the historical record doesn't keep re-seeding the error. (The substantive claims — file exists, frontend job now runs `pnpm test` — are all true.)

### F2 — LOW (guard substring rule, examined and judged non-blocking).
`includes("test")` passes any DB name containing the substring; proven by seeding 3 rows into a throwaway DB named `latest`. Adequate for the real database (`sprout` is refused), so not a blocker for a test-only helper; tighten to exact/`_test`-suffix match if you want the guard to read the way it sounds.

### Round 1's F1/F2/F3 are closed by this round
- F1 (frontend `pnpm test` missing from CI): fixed, `ci.yml:27`, YAML parses. Not executable here — see § D item 8.
- F2 (unguarded seed helper): fixed, `e2e-seed-runs.ts:27-35`, refusal + legit path both proven live.
- F3 (contract under-documents strictness): fixed, `api-contract.md:129`, matches `routes/runs.ts:21-23`.

## C. What I could not verify (Round 2)

- **GitHub Actions executing the new job.** The workflow *parses* and is *positioned correctly*; whether this repo's Actions actually runs it (and that the repo is even on GitHub with Actions enabled) is a human check — carried forward in § D item 8. If CI is dead, F1 has no operational impact but the file is still correct.
- **A genuinely-tight guard.** I proved the loose substring rule by construction (`latest` passes); I could not prove a *tight* rule, because the guard is the loose one. The deployment-relevant case (`sprout`) is covered either way.
- Round 1's outstanding items (§ C of that round) remain: OTP paste bridge end-to-end, real HRHub/Telegram/live runs, visual judgment, and the two boundary-combination probes.

## D. What only a human can check — `[manual]` (Round 2 carries all rows forward)

Results column intentionally empty.

| # | Check | Exact click sequence | Pass looks like |
|---|---|---|---|
| 1 | Dates read correctly with >10 runs | Log in → Runs panel has >10 runs → read the Date column | Two most recent *local* days read `Today`/`Yesterday`; older rows `Wed 12 Aug`; a row from a prior year carries the year; no ambiguity which day a run belongs to. Try at a Manila-locale browser AND one in UTC+0 |
| 2 | Show more | Click **Show more** twice with ≥40 runs | Rows append (10 → 30 → 40), `Showing N` stays honest, the button disappears after the last row |
| 3 | Show more survives a live run's 1.5 s poll | With ≥40 runs, click **Show more** (30 rows), then **Clock in now** | New run appears at top, table keeps refreshing, set does **not** collapse back to 10 |
| 4 | 375 px expand | DevTools → 375×812 → expand any row | The **table** scrolls sideways in its wrapper, the **page** does not; the step log wraps; the row is comfortably tappable |
| 5 | CredentialsPanel copy as a first-timer | Gmail card → **How do I set this up?** | It is obvious the mailbox must be Google/Workspace, and what to do if HRHub mails another provider |
| 6 | OTP paste bridge still accepts a code | During a real run at the OTP step, type the code → **Submit OTP** | Code accepted, run proceeds |
| 7 | Onboarding one-pager (9C) | — | The human deliverable exists |
| 8 | **CI actually ran the frontend tests on the next push** (NEW — this round's fix) | Push/merge after the review commit; open the Actions run for the frontend job | The job shows a `pnpm test` step that ran the 5 vitest tests green (and `pnpm lint` + `pnpm build` after it). Also confirms the workflow parses on GitHub's parser, not just PyYAML |

## E. Round-2 probe evidence

```
# F2 refusal (real dev DB): exit 1, zero rows
DATABASE_URL=…sprout  tsx test/e2e-seed-runs.ts <uid> 3   → exit 1, "refusing to seed: connected database \"sprout\" is not a test database"
runs count in sprout: 13 before, 13 after

# F2 legit path: exit 0, row lands, then deleted
DATABASE_URL=…sprout_test  tsx test/e2e-seed-runs.ts 2140ea8b… 1   → exit 0; runs 0→1 for that user; DELETE 1 → 0

# F2 substring bypass: DB named "latest" passes and writes
create database latest; pg_dump sprout_test --schema-only → restored into latest; insert valid user
DATABASE_URL=…latest  tsx test/e2e-seed-runs.ts <uid> 3   → exit 0; runs 0→3   (throwaway DB dropped afterwards)

# F1a YAML
yaml.safe_load(ci.yml) → parsed OK; frontend steps = install --frozen-lockfile, lint, test, build

# F1b provenance
git show --stat 4323518      → .github/workflows/ci.yml | 2 +  (modified, not created)
git log --follow -- ci.yml   → 4323518 (phase-L, +2 lint lines), 2aa6559 (phase-0, created)
```

The working tree at hand-off is the round-2 fix set exactly (five files with 8/14 mtimes; every other round-1 file byte-verified via blob/mtime); the tester's scratch artifacts (the `latest` database, injected rows in `sprout_test`, env-var shells) were removed.
