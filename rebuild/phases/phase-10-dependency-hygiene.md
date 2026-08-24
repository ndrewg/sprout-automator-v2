# Phase 10 — Dependency hygiene, and a CI gate you can trust again

**Goal:** get `pnpm audit --audit-level=high` back to green on the backend, and decide deliberately whether it stays a hard CI gate.

**Do this before phase 16.** Phase 16 (admin visibility) is gated on a second person having an account; this is not gated on anything and CI is red until it lands.

**Attach for this session:** `reference/supply-chain-and-ci.md` (the reasoning behind the audit gate), `03-CONVENTIONS-AND-GUARDRAILS.md`, `reference/testing-strategy.md`, `reference/database-schema.md` (for § 10B).

> 📡 **Fetch live docs (Context7):** Drizzle ORM migration/upgrade notes for the 0.36 → 0.45+ range, and the vitest major you install. Do not upgrade an ORM from memory.

---

## The situation

CI's **backend** job fails at `pnpm audit --audit-level=high`:

```
17 vulnerabilities found
Severity: 7 moderate | 9 high | 1 critical
##[error]Process completed with exit code 1
```

**Nothing in the codebase caused this.** `pnpm audit` consults a live advisory database, so a repository that compiled and tested clean yesterday fails today because someone published an advisory. Phase 9 touched no backend dependency; this was already red and went unnoticed because nobody had pushed.

**Why it matters more than the vulnerabilities themselves.** A permanently-red pipeline is one people stop reading. Phase 9 just wired the frontend unit tests into CI specifically so a regression would be caught there — that signal is worth nothing if the run is red anyway and everyone learned to ignore the ❌.

**Triage — 13 of the 17 do not ship.** They arrive through `vitest`, a devDependency, and the production image installs with `pnpm install --frozen-lockfile --prod`. That includes the single "critical" (Vitest's UI server exposing arbitrary files), which additionally requires running Vitest UI, which this project never does.

**Four are in runtime dependencies:**

| Package | Installed | Fixed in | Advisory |
|---|---|---|---|
| **`drizzle-orm`** | **^0.36.0** | **≥0.45.2** | **HIGH — SQL injection via improperly escaped SQL identifiers** (GHSA-gpj5-g38j-94v9) |
| `date-holidays` | ^3.23.12 | see below | js-yaml quadratic CPU (×2, transitive) |
| `mailparser` | ^3.7.2 | see below | linkify-it ReDoS via `mailto:` (transitive) |
| `imapflow` | ^1.3.3 | see below | ip-address leading-zero octet parsing (transitive) |

**On the drizzle advisory specifically.** "SQL identifiers" means table and column names. In this codebase identifiers come from `src/db/schema.ts` and are static; every user-supplied value goes through Drizzle's parameter binding. So the app is **most likely not exploitable** — but that is reasoning from the shape of the advisory, not a proof, and being nine minor versions behind on the library that talks to the database is not a position to defend. Treat it as a real upgrade, not a formality.

---

## 10A — Bump the backend test runner (the easy 13)

**Contract:**
- Upgrade `vitest` in `app/backend` from `^2.1.0` to a current major. **Fetch the current version via Context7** and check its Vite peer requirement.
- The frontend independently runs `vitest ^4.1.x` (phase 9, chosen because it is the first major supporting Vite 8). The two packages install separately, so they need not match — but if the same major works for both, take it and say so.
- Watch `app/backend/vitest.config.ts`: the **projects** API (`unit` / `integration`) changed shape across recent majors. `pnpm test` and `pnpm test:integration` must keep meaning exactly what they mean today.
- `minimumReleaseAge: 1440` in `app/backend/pnpm-workspace.yaml` — the version must be at least 24 h old. If a new build script appears, add it to `allowBuilds` and report it.

**Gate 10A:**
```
cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration
cd app/backend && pnpm audit --audit-level=high
```
Baseline is **161 unit / 106 integration** — the counts must be unchanged. A test runner upgrade that changes how many tests run has changed what is being tested; investigate before proceeding.

Record how many of the 17 advisories this clears.

---

## 10B — Upgrade Drizzle deliberately

**This is the one with real risk.** `drizzle-orm ^0.36.0` → **≥0.45.2**, nine minor versions, on the library that owns the schema, the migrations and every query.

**Contract:**
- Upgrade `drizzle-orm` and `drizzle-kit` **together** — a mismatched pair produces migrations the runtime cannot read.
- **Read the upgrade notes via Context7 before changing the version string.** Note in the report every breaking change that applied to this codebase and what you did about it.
- **Do not edit any committed migration** (AGENTS.md rule 13). If the new `drizzle-kit` wants to regenerate or reformat `drizzle/`, stop and ask — do not let a tool rewrite migration history.
- **Do not regenerate a migration to "sync" the schema.** Run `pnpm db:generate` only if a genuine schema change is required, which it should not be here.
- Pay attention to the query surfaces this project relies on: the **partial unique index** race guard (`runs_one_active_per_user`), the `23505` catch that turns a race into `409 already_running`, `ON DELETE CASCADE` behaviour used by account deletion, and the `jsonb` `steps` column with its `$type<>()` annotation.

**Verification, in this order:**
1. `pnpm typecheck` — the first thing a Drizzle major breaks is types.
2. `pnpm test && pnpm test:integration` — **106 integration tests against a real database are the safety net here.** Any change in count or any skip is a finding.
3. **Apply the migrations to a scratch database from empty** and confirm the resulting schema matches: `pnpm db:migrate` against a fresh DB, then diff the table/index/constraint list against the current `sprout` database. A migration runner that silently stops applying old migrations is the failure mode that would not show up in tests.
4. Confirm the race guard still behaves: `race-guard.test.ts` must still pass **and still be able to fail** — break the partial index expectation and confirm it goes red.

**Gate 10B:**
```
cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration
cd app/backend && pnpm audit --audit-level=high
```

**`[manual]`:** a real `docker compose up -d --build` boot, a real login, and one real "Clock in now" against live HRHub. An ORM upgrade that passes tests but breaks a real run is exactly the class of failure this project's `[manual]` layer exists for.

---

## 10C — The three transitive ones

`date-holidays`, `mailparser` and `imapflow` each pull a vulnerable transitive (`js-yaml`, `linkify-it`, `ip-address`).

**Contract:**
- First try a plain bump of each direct dependency to its latest — usually the transitive comes along.
- If a direct bump does not clear it, **do not add a `pnpm.overrides` entry silently.** An override pins a version the package did not choose and is a maintenance liability; if you use one, say so explicitly in the report with the reason.
- Module-ownership rules still hold (AGENTS.md rule 9): `date-holidays` only in `lib/ph-holidays.ts`, `imapflow`/`mailparser` only in `lib/imap-otp.ts`.
- `ph-holidays.ts` reads `"public"` and `"bank"` holiday types — verify that still behaves after the bump, and that `imap-otp.ts` still connects (`Test Gmail connection` in the UI is the fast check).

**Gate 10C:** same as 10B, plus `pnpm audit --audit-level=high` reporting **0 high, 0 critical**.

---

## 10D — Decide what the gate means

**This is the part that stops the problem recurring, and it is a decision, not a code change.**

`pnpm audit --audit-level=high` consults a live database. It will go red again on a day nobody committed anything — that is not a malfunction, it is what the tool is. So choose deliberately:

- **Keep it blocking.** Honest, and the reason it caught this. Cost: CI can break with no code change, and someone must respond promptly or the pipeline rots again.
- **Keep it blocking but scope it to production dependencies** — `pnpm audit --audit-level=high --prod`. This is the option worth taking seriously: **13 of today's 17 findings do not ship**, and a gate that fails on tooling nobody deploys is mostly noise. It keeps a real signal for anything reaching users.
- **Make it advisory** (`continue-on-error: true`) so the run stays green and the finding is visible. Weakest — an advisory check is one nobody reads.

**Recommendation: `--prod`, blocking**, with the dev-dependency audit run separately and non-blocking so it is still visible. Implement whichever is chosen, and **record the decision and its reasoning in `reference/supply-chain-and-ci.md`** — that document is where the gate came from, and the next person to see a red pipeline needs to know the choice was made on purpose.

**Gate 10D:** `.github/workflows/ci.yml` parses; the backend job's audit step reflects the decision; the reasoning is written down.

---

## Verification Gate (the whole phase)

```
cd app/backend  && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration
cd app/backend  && pnpm audit --audit-level=high        # per the 10D decision
cd app/frontend && pnpm lint && pnpm test && pnpm build && pnpm test:e2e
python -c "import yaml;yaml.safe_load(open('.github/workflows/ci.yml'))"
```

Baselines: **161 backend unit / 106 backend integration / 5 frontend unit / 16 e2e.** A change in any count is a finding, not a detail.

**`[manual]` — must not be claimed as passed:**

| # | Check | Pass looks like |
|---|---|---|
| 1 | `docker compose up -d --build`, then log in | Boots clean, no config or migration errors in the log |
| 2 | Apply migrations to an empty scratch DB, diff the schema against `sprout` | Identical tables, indexes and constraints — including the partial unique index |
| 3 | One real "Clock in now" against live HRHub | Completes (`success` or `skipped`) with a sensible step log |
| 4 | "Test Gmail connection" | Still connects after the `imapflow` bump |
| 5 | Push and open the Actions tab | **Both** jobs green — the point of the phase |

Commit per the loop in `AGENTS.md` — implementer reports, tester probes, reviewer commits. Tag `phase-10-complete` when the `[manual]` rows are filled in.
