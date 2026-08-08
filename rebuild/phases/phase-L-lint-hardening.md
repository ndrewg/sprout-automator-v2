# Phase L — Lint Hardening

**Runs BEFORE phase 5.** "L" not a number, because like phase T it is infrastructure rather than a product phase: it protects everything built after it.

**Goal:** make linting something that actually runs and actually catches things. Today it is a script nobody invokes, configured to almost nothing.

**Attach for this session:** `03-CONVENTIONS-AND-GUARDRAILS.md`, `reference/testing-strategy.md`, `reference/supply-chain-and-ci.md`, `reference/live-docs-and-mcp.md`.

> 📡 **Fetch live docs first (Context7):** **oxlint** — its config schema, category names, plugin list and rule coverage move fast, and the version installed here (frontend `devDependencies`) is what matters. Do **not** write `.oxlintrc.json` from memory.

---

## Why this round exists (audit, 2026-08-08)

| | Found |
|---|---|
| Frontend linter | oxlint installed, `pnpm lint` script present |
| Frontend rules | **two**, hand-listed — which *replaces* the default set, so the entire correctness category is off |
| Backend linter | **none** — no config, no script, no dependency |
| Lint in CI | **no** — CI runs backend typecheck/test/audit and frontend `build` only |
| Lint in pre-commit | **no** — the only hook is gitleaks |
| lint-staged / husky | not installed |

The trigger was a genuine bug that shipped in phase 3 and survived every gate until someone opened the browser console: `RunsPanel` returned a fragment shorthand from `.map()` with the `key` on the inner `<tr>`, so React fell back to index reconciliation on a list that refetches every 1.5 s and inserts new rows at the top.

> ⚠️ **As-built (2026-08-08): the caveat this section originally carried was WRONG — disregard it.** The draft claimed oxlint could not catch the fragment-shorthand key bug even with `react/jsx-key` enabled. That conclusion came from a test that set `"react/jsx-key": "error"` as a bare string, leaving `checkFragmentShorthand` at its default — i.e. the one option that governs this exact case was never actually passed. On the installed **oxlint 1.71.0** the option is supported, and with `["error", { "checkFragmentShorthand": true }]` the exact pre-fix `RunsPanel.tsx` is reported: `error react(jsx-key): Missing "key" prop for element in iterator`. **This round's trigger bug is caught.** Verified independently twice.

The general lesson stands even though the specific claim did not: find out what the tooling *can* catch by probing it, and report what it misses rather than implying coverage.

---

## L1 — Frontend: turn the linter on properly

`app/frontend/.oxlintrc.json` currently lists two rules, which suppresses everything else.

- Enable the **correctness** category rather than hand-picking rules. Keep the two existing entries only if they differ from the category default.
- Turn on `checkFragmentShorthand` for the JSX key rule **if the installed oxlint supports it** — verify against fetched docs. If it does not, say so in the Handoff report rather than silently omitting it, and note what would be needed instead (an ESLint pass with `eslint-plugin-react`, which is a dependency decision for the human, **not** for you to take).
- Enable React hooks dependency checking if available (`exhaustive-deps` or its oxlint equivalent). Several panels seed `useState` from query data inside `useEffect`; a missing dependency there is exactly the class of bug that reads as "the form sometimes shows stale values".

Enabling a category **will surface existing violations**. For each one: fix it, or add a narrowly-scoped disable with a comment saying why. **Do not silence a rule globally to make the baseline green** — that recreates the problem this round exists to fix.

## L2 — Backend: give it a linter at all

The backend has none. Add oxlint as a devDependency, an `.oxlintrc.json`, and a `lint` script matching the frontend's shape. Enable the correctness category plus the TypeScript plugin.

The backend has house rules a linter can enforce that `tsc` cannot — most valuably **no floating promises** and **no misused promises**, if the installed oxlint supports them. Those map directly to `AGENTS.md` rule 2 (async/await with try/catch, never `.then().catch()` for control flow) and to the fire-and-forget dispatch idiom, where an unhandled rejection is the exact failure mode. If the rules exist, turn them on and fix what they find; the three sanctioned `.catch()` idioms get narrow inline disables with a comment pointing at the rule.

## L3 — Wire it into things that run

1. **CI** (`.github/workflows/ci.yml`) — add `pnpm lint` to **both** jobs, before the tests. This is the backstop that cannot be skipped.
2. **pre-commit** (`.pre-commit-config.yaml`) — add local hooks running each `pnpm lint` alongside gitleaks. Use `language: system`, `pass_filenames: false`, and scope each with `files:` so a backend-only commit doesn't lint the frontend. If this proves unreliable on Windows, **say so and leave CI as the guarantee** — a hook that fails confusingly is worse than no hook.

Do **not** add husky or lint-staged. The `pre-commit` framework is already installed and doing this job; a second hook manager is new surface for no gain.

## L4 — A genuinely clean baseline

`pnpm lint` must exit 0 on both packages with **zero warnings**, not merely zero errors. Two `react/only-export-components` warnings exist today in shadcn-generated `button.tsx` and `badge.tsx`. Fix them or add a scoped disable with a comment explaining that the CLI generates that shape. A baseline with permanent warnings trains everyone to ignore output, which is how the console warning that started this round went unread for weeks.

---

## Verification Gate

```bash
cd app/backend  && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration
cd app/frontend && pnpm lint && pnpm build && pnpm test:e2e
```

All green, **zero warnings** from either `lint`.

**Prove the linter can fail** — this is the point of the round, not a formality. For each of these, introduce the fault in a scratch file, confirm lint reports it, then remove the file:

1. A floating promise in backend code (if the rule is available).
2. A `.then().catch()` control-flow chain (if a rule covers it).
3. A React hook called conditionally.
4. **The fragment-shorthand missing key**, using `git show f7d631d^:app/frontend/src/components/panels/RunsPanel.tsx` as the probe. **Report honestly whether it is caught.** If not, that is a finding for the Handoff report, not something to paper over.

Report which faults were caught and which were not. A linter that runs everywhere and catches nothing is worse than none, because it looks like coverage.

---

> ⚠️ **As-built (2026-08-08) — complete.** All four fault probes were introduced, confirmed reported, and removed:
> | Probe | Rule that caught it |
> |---|---|
> | Fragment-shorthand missing `key` (the trigger bug, from `f7d631d^`) | `react/jsx-key` + `checkFragmentShorthand: true` |
> | Floating promise | `typescript/no-floating-promises` |
> | `.then().catch()` control flow | `promise/prefer-await-to-then` |
> | Conditional React hook | `react/rules-of-hooks` |
>
> **Two things the phase file did not anticipate.** The backend type-aware rules need the `oxlint-tsgolint` companion package plus `options.typeAware: true` — neither is optional, and without them `no-floating-promises` silently does nothing. And `promise/prefer-await-to-then` was added beyond the two named rules: it is the only rule covering the `.then().catch()` case, which was L2's whole point. Both were the right calls.
>
> Six real findings were fixed on the backend (unused imports and variables in three test files, a stale `@typescript-eslint` directive, plus scoped disables for the intentional control-character regex and the fire-and-forget executor). `pnpm exec oxlint --report-unused-disable-directives` is clean on both packages, so no disable is dead weight.
