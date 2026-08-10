# AGENTS.md — Sprout Automator (always-on rules)

You are implementing the Sprout Automator from the spec in `rebuild/`. **All architecture is already decided** — do not redesign, do not propose alternatives, do not "improve" the stack. Produce correct, complete TypeScript that matches the spec's contracts exactly.

**Start every session by reading `rebuild/STATE.md`** — it says what is actually built, what is next, and where the phase docs have drifted from reality. When a phase file and STATE.md disagree, STATE.md wins. **And leave it accurate when you finish** — see "Keep the ledger current" below. A session that advances the code without advancing the ledger costs the next session more than it saved.

## How we work
- **Work one phase per session, gate by gate within it.** Run each gate before starting the next; finish the phase, then report and stop. Gates are not stopping points — they are the evidence that the work so far is correct.
- **A gate is a command with an exit code.** `pnpm typecheck && pnpm test` passes or it doesn't. Checks that genuinely need a human (a Telegram message arriving, a live HRHub run, a 375px layout) are marked **`[manual]`** — do not claim those passed; report them as needing the human. **Never report a gate green because the code looks right.** See `rebuild/reference/testing-strategy.md`.
- When a section says **"copy verbatim"**, reproduce it exactly — do not refactor, rename, or reformat it.
- Emit **complete files**. Never write "// rest unchanged".
- If the spec is ambiguous or missing something, **stop and ask one specific question** — do not invent.
- **Ignore any `_archive/`, `archive/`, or `reference-old/` directory.** Stale prior-build code using patterns this spec has **superseded** (`.js` import extensions, hardcoded holiday maps). Never read it to decide how to build; never copy from it. The only source of truth is `rebuild/`.
- **Phases 0–5 are an as-built record, not instructions.** They document what was built and why, including corrections found during the build. Read them for context; don't re-run them. New work is phase 6+ and `rebuild/BACKLOG.md`.
- **Phase 3 UI — two skills, distinct lanes:** the **`shadcn` skill** is the authority for shadcn component work (init/add/docs/compose + styling rules; v4-aware; injects project context — it wins on shadcn specifics); **`ui-ux-pro-max`** is for design decisions + `Platform: Web` UX/responsive review. Context7 = docs for everything else. The dashboard must be **responsive** (used on phones); apply ui-ux-pro-max's `Platform: Web` rules and **skip** its React-Native / native-only rules (44pt touch, safe-area, haptics, VoiceOver).

## Model routing
The default model has **no vision**. One task in this project needs it: when a run fails at the clock step, the screenshots in `data/screenshots/<userId>/<runId>/` are the only signal for whether HRHub changed its markup. **Hand that task to a vision-capable model** along with `rebuild/reference/hrhub-automation-playbook.md`; don't guess at selector drift from text alone, and don't burn a multimodal model on ordinary coding turns. Everything else — code, tests, migrations, review — is text-only by design, which is why the gates are executable.

## The loop: implement → verify → report → test → review → commit

**Three separate sessions, a human relaying between them.** Full prompts for each role are in `rebuild/SESSION-PROMPT.md`. **Only the reviewer runs `git`.**

1. **Implement** (coding model) — work the item **gate by gate**. A gate is a verification checkpoint: run it, and do not start the next until it is green. Continue to the end of the item. Do not stop at each gate.
2. **Verify** — `pnpm typecheck && pnpm test` (+ `pnpm test:integration` / `pnpm test:e2e` where the item says so). **Never proceed past a red gate by explaining why the failure is acceptable.** If you cannot make it green, stop and report that.
3. **Report** — emit the **Handoff report** below. This is the deliverable.
4. **Test** (fresh session — *not* the implementer's, which would inherit its blind spots). The tester's job is to **try to make the report's claims false**: re-run every gate, diff the report against the actual changes, break each new test to prove it can fail, attack the change, query the database directly. It writes `rebuild/reviews/<item>-addendum.md` and lists what only a human can check. It does not fix anything and does not run `git`.
5. **Review** (reviewer model, fresh session) — reads the diff against these rules and the tester's addendum. Neither the report nor the addendum is evidence; re-run the gates. Section C of the addendum ("what I could not verify") is where to look hardest.
6. **Commit** (reviewer, only after its own review passes).

**What none of them replaces:** in this build, review caught the invisible defects — a privilege escalation, an unrate-limited endpoint — while *a human using the app* caught eleven others, every one of them while the gates were green. The `[manual]` section of an addendum is not ceremony; it has historically found more than the rest combined.

### The Handoff report (the implementer's final output — always emit this)

```
## Handoff report — phase <N> <name>

**Gates:** <which passed, e.g. 6A ✅ 6B ✅ 6C ✅>
**Status:** complete | blocked at <gate>

**What I changed** (grouped by gate)
- <gate>: `path/to/file` — one line on what and why
  …

**Gate output** (verbatim tail, not a summary)
```
$ pnpm typecheck && pnpm test
…
```

**[manual] checks outstanding** — for the human, not claimed as passed
- …

**Spec divergences** — where the phase file was wrong or incomplete, and what I did instead
- …

**Assumptions I made** — anything I decided without the spec saying so
- …
```

Be honest in the last three sections. An omission there is invisible to the reviewer and becomes a bug the next session inherits. "None" is a valid answer; a wrong "none" is not.

### Commit rules
- **One commit per phase**, made by the reviewer after review passes. Gates remain the verification checkpoint but are no longer separate commits — review happens once per phase, and splitting a mixed working tree back into per-gate commits is error-prone.
- **Never commit a red gate.** A commit means "this provably works" — `typecheck` + tests green, `[manual]` checks listed as outstanding in the commit body rather than assumed.
- **The implementer never commits.** Only the reviewer, and only after step 4. That is the point of the split: the model that wrote the code is the worst judge of whether it works.
- Conventional-commit style scoped to the phase: `feat(phase-6): telegram notifications + missed-run reconciliation`. List the gates covered in the body.
- **Never bypass the hooks.** No `--no-verify`, no `-c core.hooksPath=`. The gitleaks pre-commit hook is the last thing standing between a bot token and the repository history — if it fires, it is right and you are wrong.
- **Stage deliberately.** Name the files; no blanket `git add -A`. **Do** commit generated `drizzle/` migrations. **Never** commit `.env`, `data/`, or anything from `_archive/`.
- **Do not `push`, `amend`, `rebase`, `reset --hard`, or force anything** unless the human explicitly asks. Local commits are cheap and reversible; rewritten history is not.
- **Tagging** (`git tag phase-6-complete`) happens only when a phase's full gate is green, including its `[manual]` checks — so in practice the human tags, because only they can confirm a Telegram message arrived or a run reached real HRHub.

### Keep the ledger current — part of the same commit
`rebuild/STATE.md` is what the next session reads to know where things stand. A commit that changes what is built and doesn't update it has made the project *harder* to resume.

At every green gate, in the same commit as the code:
- Move the item in **`rebuild/STATE.md`** from "Not built" to "Built and verified", and add anything newly discovered to "Known gaps".
- If reality diverged from the phase file — a different option chosen, an API that didn't work as specced, an extra step needed — **add a dated correction note to the phase file itself**, in the style already used there: `> ⚠️ **As-built (found 2026-08):** …`. Do not silently leave the spec wrong; the next session will believe it.
- Tick the item off in **`rebuild/BACKLOG.md`** if it was listed there.

## Hard rules (each maps to a real decision or a real bug)
1. **TypeScript only, ESM.** `moduleResolution: "Bundler"` + run via `tsx`. **No `.js` extensions on relative imports.** No compile step for the backend. Stack is **LATEST**: **Express 5, Postgres 18, Playwright 1.60, Node 22, pnpm 11**; frontend **React 19 + Tailwind 4 + shadcn-latest + Vite + TanStack Query v5**. Tailwind v4 is CSS-first (no `tailwind.config.js`/postcss); use the `shadcn@latest` CLI to scaffold components.
   - **📡 Live docs, not memory:** much of this stack post-dates most training cutoffs. For any such library (React 19, Tailwind 4, shadcn, Express 5, Drizzle, Zod, Playwright 1.60, pnpm 11, TanStack Query v5, …) **call the docs MCP (Context7: `resolve-library-id` → `get-library-docs`) and write from the returned current API — do NOT emit a remembered API.** If docs contradict memory, docs win. No docs tool available → ask, don't guess. See `rebuild/reference/live-docs-and-mcp.md`. (The pinned code in `reference/*` is already correct — reproduce it verbatim; fetch docs for everything else.)
   - **Express 5:** async route handlers may `throw`; rejections reach the global error middleware automatically. Still validate with Zod and respond explicitly. The SPA catch-all is a **regex**, not `"*"`.
   - **pnpm 11, not npm:** commands are `pnpm install` / `pnpm dev` / `pnpm typecheck` / `pnpm db:migrate`; installs use `--frozen-lockfile`. Don't add a dependency casually — each new dep is supply-chain surface; if you must, add it with `pnpm add` and note it. New build scripts require an `allowBuilds` entry in `pnpm-workspace.yaml`.
2. **Async/await + try/catch for ALL sequential logic. Never `.then().catch()` for control flow.** The only allowed `.catch()` are four contained idioms, reproduced verbatim where the spec shows them: Playwright best-effort probes (`await locator.isVisible().catch(() => false)`), fire-and-forget cleanup (`.catch(() => {})`), the top-level `main().catch(...)`, and executor backstops that mark a run failure (`.catch((err) => failRunFromExecutor(runId, err))`). Never generalize them.
3. **Modern idioms:** `const`/`let` (never `var`); `?.`/`??`; `for...of` or `Promise.all`/`any` for awaiting loops (never `await` in `.forEach`); `node:` import specifier for built-ins; `catch (err: unknown)` + narrowing.
4. **Secrets never leak** — no password, app password, OTP code, bot token, session id, or key in any log, response body, error message, or audit metadata. `GET /credentials` returns passwords only as `*Set` booleans; `GET /notifications` returns the bot token only as `telegramTokenSet`.
5. **Tenant isolation** — every query scoped to `req.user.id`; never accept a user id from the request; file paths derived from the authed UUID.
6. **Auth:** Argon2id (not bcrypt); DB-backed signed-cookie sessions (no JWT).
7. **Credentials:** AES-256-GCM, key from env, only `lib/encryption.ts` touches `*_enc` columns. Partial-update semantics: omit=keep, string=set, null=clear.
8. **Runs:** insert as `pending` and let the partial unique index gate — catch Postgres `23505` → `already_running`. Never `SELECT WHERE running` then `INSERT`. The same "let the database decide" pattern gates missed-run notices.
9. **Module ownership:** import `playwright` only in `src/automation/*` (`test/` is exempt — e2e needs it); `imapflow`/`mailparser` only in `lib/imap-otp.ts`; `date-holidays` only in `lib/ph-holidays.ts`; the Telegram HTTP API only in `lib/telegram.ts`.
10. **HRHub automation:** reproduce selectors verbatim; 1920×1080 viewport; CSS-class selectors (never `getByText`) for the clock buttons; reload after OTP; already-clocked guard fails safe (skip on doubt). Don't widen the OTP regex `(?<!\d)(\d{4,6})(?!\d)`. **`clock.ts` is the most brittle file in the repo — do not tidy it.**
11. **Notifications never affect runs.** Dispatch is fire-and-forget; a dead Telegram endpoint must not change a run's status, timing, or HTTP response. This is asserted by a test, not by intent.
12. **Frontend:** TanStack Query owns server state; `useState` for ephemeral UI only. Inside an `async` handler with `try/catch`, use `await mutation.mutateAsync(...)` — never fire-and-forget `mutate()` and expect the catch to run. Plain `mutate()` only in a non-async handler (e.g. `onClick={() => logout.mutate()}`).
13. **Don't add** CSRF tokens, CORS, JWT, `.js` extensions, an auto-enabled schedule or notification setting on signup, or edits to committed migrations.

Full detail: `rebuild/03-CONVENTIONS-AND-GUARDRAILS.md` (conventions + the DO-NOT list), `rebuild/02-DECISIONS-AND-ARCHITECTURE.md` (why each decision is locked), `rebuild/STATE.md` (what's built), `rebuild/BACKLOG.md` (what's known-missing). Read `rebuild/00-START-HERE.md` for the session protocol.
