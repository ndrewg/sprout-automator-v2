# AGENTS.md — Sprout Automator rebuild (always-on rules)

You are implementing the Sprout Automator from the spec in this `rebuild/` directory. **All architecture is already decided** — do not redesign, do not propose alternatives, do not "improve" the stack. Produce correct, complete, copy-paste-ready TypeScript that matches the spec's contracts exactly.

## How we work
- **One phase per session.** Implement only the `phases/phase-N-*.md` you've been given. Run its **Verification Gate** before anything is considered done. If a phase has numbered sub-steps (2A, 2B…), it's fine to do them as separate turns.
- When a section says **"copy verbatim"**, reproduce it exactly — do not refactor, rename, or reformat it.
- Emit **complete files** (path heading + full contents). Never write "// rest unchanged".
- If the spec is ambiguous or missing something, **stop and ask one specific question** — do not invent.
- **Ignore any `_archive/`, `archive/`, or `reference-old/` directory.** It is stale prior-build code kept only for human reference, and it uses patterns this spec has **superseded** (e.g. `.js` import extensions, hardcoded holiday maps). Never read it to decide how to build, and never copy code out of it. The only source of truth is `rebuild/`.

## Commit strategy
- **Commit at every green Verification Gate** (the sub-steps: 1A, 2B, 3C, …), not once per phase. Each gate is a verified, safe rollback point.
- **Never commit a red gate.** Commit only after `typecheck` + the gate's behavior checks pass — a commit must mean "this checkpoint provably works."
- **You (the agent) do NOT run git.** Implement and verify; the human runs `git commit` and decides when. Never auto-commit, amend, push, or tag unless explicitly told.
- Conventional-commit style with a phase/gate scope, e.g. `feat(phase-2): run queue + DB single-active-run guard [gate 2B]`.
- **Do** commit generated `drizzle/` migrations. **Never** commit `.env` or `data/`.
- Each phase file lists its exact commit checkpoints; tag phase completions (`git tag phase-2-complete`).

## Hard rules (each maps to a real decision or a real bug)
1. **TypeScript only, ESM.** `moduleResolution: "Bundler"` + run via `tsx`. **No `.js` extensions on relative imports.** No compile step for the backend. Stack: **Express 5, Postgres 18, Playwright 1.60, Node 22, pnpm 11**; frontend **React 18 / Tailwind 3** (do not introduce React 19 / Tailwind 4 — that's a separate documented upgrade).
   - **Express 5:** async route handlers may `throw`; rejections reach the global error middleware automatically. Still validate with Zod and respond explicitly. The SPA catch-all is a **regex**, not `"*"`.
   - **pnpm 11, not npm:** commands are `pnpm install` / `pnpm dev` / `pnpm typecheck` / `pnpm db:migrate`; installs use `--frozen-lockfile`. Don't add a dependency casually — each new dep is supply-chain surface; if you must, add it with `pnpm add` and note it. New build scripts require an `allowBuilds` entry in `pnpm-workspace.yaml`.
2. **Async/await + try/catch for ALL sequential logic. Never `.then().catch()` for control flow.** The only allowed `.catch()` are three contained idioms, reproduced verbatim where the spec shows them: Playwright best-effort probes (`await locator.isVisible().catch(() => false)`), fire-and-forget cleanup (`.catch(() => {})`), and the top-level `main().catch(...)`. Never generalize them.
3. **Modern idioms:** `const`/`let` (never `var`); `?.`/`??`; `for...of` or `Promise.all`/`any` for awaiting loops (never `await` in `.forEach`); `node:` import specifier for built-ins; `catch (err: unknown)` + narrowing.
4. **Secrets never leak** — no password, app password, OTP code, session id, or key in any log, response body, error message, or audit metadata. `GET /credentials` returns passwords only as `*Set` booleans.
5. **Tenant isolation** — every query scoped to `req.user.id`; never accept a user id from the request; file paths derived from the authed UUID.
6. **Auth:** Argon2id (not bcrypt); DB-backed signed-cookie sessions (no JWT).
7. **Credentials:** AES-256-GCM, key from env, only `lib/encryption.ts` touches `*_enc` columns. Partial-update semantics: omit=keep, string=set, null=clear.
8. **Runs:** insert as `pending` and let the partial unique index gate — catch Postgres `23505` → `already_running`. Never `SELECT WHERE running` then `INSERT`.
9. **Module ownership:** import `playwright` only in `src/automation/*`; `imapflow`/`mailparser` only in `lib/imap-otp.ts`; `date-holidays` only in `lib/ph-holidays.ts`.
10. **HRHub automation:** reproduce selectors verbatim; 1920×1080 viewport; CSS-class selectors (never `getByText`) for the clock buttons; reload after OTP; already-clocked guard fails safe (skip on doubt). Don't widen the OTP regex `(?<!\d)(\d{4,6})(?!\d)`.
11. **Frontend:** TanStack Query owns server state; `useState` for ephemeral UI only. Inside an `async` handler with `try/catch`, use `await mutation.mutateAsync(...)` — never fire-and-forget `mutate()` and expect the catch to run. Plain `mutate()` only in a non-async handler (e.g. `onClick={() => logout.mutate()}`).
12. **Don't add** CSRF tokens, CORS, JWT, `.js` extensions, an auto-enabled schedule on signup, or edits to committed migrations.

Full detail lives in `03-CONVENTIONS-AND-GUARDRAILS.md` (conventions + the 18-item DO-NOT list) and `02-DECISIONS-AND-ARCHITECTURE.md` (why each decision is locked). Read `00-START-HERE.md` for the session protocol.
