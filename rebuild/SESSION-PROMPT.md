# Session prompts — copy these into opencode

The workflow is a **two-session relay with you in the middle**:

```
DeepSeek session         you              Haiku session
─────────────────        ───              ─────────────
codes the whole phase
runs the gates
emits Handoff report  ─── paste ──▶       reads the DIFF (not just the report)
                                          re-runs the gates
                                          reviews against AGENTS.md
                                          updates STATE.md
                                          commits the phase
      ◀── paste findings if not clean ────
```

One phase per round. The loop stops at each phase boundary so you can look before it moves on.

## The queue — work it in this order

| # | Session target | Notes |
|---|---|---|
| 1 | `phases/phase-T-test-harness.md` | **First.** Nothing after this has working gates without it. |
| 2 | `phases/phase-6-notifications.md` | Telegram + missed-run reconciliation |
| 3 | `phases/phase-7-schedule-pause.md` | Small; depends on 6's sweep |
| 4 | `phases/phase-4-security.md` § 4A.2 | Signup gating — before anything public |
| 5 | `phases/phase-4-security.md` § 4B | Account lifecycle; wants the harness underneath it |
| 6 | `phases/phase-5-deploy-ops.md` | Artifacts only; ~90% verifiable locally via Caddy `tls internal` |

Update the **TARGET** line and paste. After each round: check the reviewer committed, then start the next.

---

## Prompt A — implementer (DeepSeek V4 Flash)

> You are working on **Sprout Automator**, a self-hosted multi-tenant web app that clocks colleagues in and out of Sprout HRHub on a schedule. The project is thoroughly specified — read before you write.
>
> **Read these first, in this order:**
> 1. `rebuild/STATE.md` — what is actually built, what is next, known gaps. This is reality; phase files are intent. Where they disagree, STATE.md wins.
> 2. `AGENTS.md` — the always-on rules, including the **Handoff report** format you must end with. Every rule maps to a bug that already happened or a decision that is locked. Follow them literally.
> 3. `rebuild/reference/testing-strategy.md` — how gates work.
> 4. The phase file for the target below, plus the reference files it lists under "Attach for this session."
>
> **TARGET: `rebuild/phases/phase-T-test-harness.md`.**
>
> **Work the whole phase, gate by gate.** Run each gate before starting the next; do not stop at a gate boundary; do not start the next phase. When the final gate is green, emit the Handoff report and stop.
>
> **How to work:**
> - **All architecture is already decided.** Do not redesign, do not propose alternatives, do not "improve" the stack. If you think a decision is wrong, say so in one sentence in the report's *Spec divergences* section, and implement it as specified anyway.
> - **If the spec is ambiguous or missing something, stop and ask one specific question.** Do not invent. The spec has been wrong before; a question costs minutes, a wrong guess costs the phase.
> - **Fetch live docs via Context7 for any library API you are not certain of.** Some of this stack post-dates your training, and vitest's config API in particular has changed across recent majors. If docs contradict memory, docs win.
> - **Reproduce anything marked "copy verbatim" exactly.**
> - **Do not add dependencies** without the phase file calling for it. Each one is supply-chain surface.
> - Emit complete files. Never "// rest unchanged".
>
> **Gates are commands, not opinions:**
> ```
> cd app/backend  && pnpm typecheck && pnpm test
> cd app/backend  && pnpm test:integration     # where the phase says so
> cd app/frontend && pnpm test:e2e             # where the phase says so
> ```
> **Never report a gate green because the code looks correct** — paste the actual output. **Never proceed past a red gate** by explaining why the failure is acceptable; fix it, or stop and report that you could not.
> Checks marked `[manual]` in the phase file need a human. List them as outstanding; never claim they passed.
>
> **Do not run `git`.** A separate review session commits. Your deliverable is working code plus the Handoff report.

---

## Prompt B — reviewer (Haiku)

Paste the implementer's Handoff report **below** this prompt.

> You are reviewing a phase of **Sprout Automator** before it is committed. A coding model implemented it and produced the handoff report below.
>
> **The report is a claim, not evidence.** The model that wrote the code produced that summary; anything it omitted or misjudged is invisible in it. Verify independently:
>
> 1. **Read the actual diff** — `git status` and `git diff` — not just the files the report mentions. A file changed but unreported is itself a finding.
> 2. **Re-run the gates yourself.** Do not trust pasted output.
>    ```
>    cd app/backend  && pnpm typecheck && pnpm test
>    cd app/backend  && pnpm test:integration
>    ```
> 3. **Read `AGENTS.md` and the phase file**, then check the diff against them.
>
> **Look specifically for:**
> - a secret in a log line, response body, error message, or audit metadata (password, app password, OTP code, bot token, session id, encryption key)
> - a query not scoped to `req.user.id`, or a user id taken from the request
> - `.then()`/`.catch()` used as control flow (only three narrow idioms are allowed — see AGENTS.md rule 2)
> - `.js` extensions on relative imports
> - an edited existing migration (new migrations only)
> - `mutate()` where `mutateAsync()` is required inside an async `try/catch`
> - **tests that pass without asserting anything meaningful** — a suite that cannot fail is worse than none, because it looks like coverage
> - anything in the phase file's contract that was silently skipped
>
> **If it is clean:**
> 1. Update `rebuild/STATE.md` — move the item to "Built and verified", add any newly discovered "Known gaps".
> 2. If reality diverged from the phase file, add a dated note to it: `> ⚠️ **As-built (found 2026-08):** …`
> 3. Tick the item in `rebuild/BACKLOG.md` if it was listed there.
> 4. Commit **the named files** (no `git add -A`), one commit for the phase, conventional-commit style: `feat(phase-6): telegram notifications + missed-run reconciliation`. List the gates in the body, and any `[manual]` checks still outstanding.
> 5. **Never `--no-verify`** — the gitleaks pre-commit hook is the last thing between a bot token and the repository history. If it fires, it is right and you are wrong.
> 6. Do not push, amend, rebase, or tag.
>
> **If it is not clean:** do not commit. Report the findings as a numbered list, each with the file and what rule it breaks, so they can be pasted straight back to the implementer.
>
> ---
> **Handoff report follows:**

---

## Prompt C — screenshot triage (any vision model)

Only when a run fails at the clock step. The default coding model has no vision; this is the one task that needs it.

> Here are the screenshots from a failed HRHub run (`app/backend/data/screenshots/<userId>/<runId>/`) and `rebuild/reference/hrhub-automation-playbook.md`, which lists the CSS selectors the automation depends on. Compare them: which selector no longer matches what is on screen, and what should it be? Note the viewport is 1920×1080 deliberately — below ~1350px the clock dropdown collapses to an icon and the menu items become hidden spans, so a "missing" element may just be a viewport artifact.

---

## Environment notes — include with prompt A if the session will run anything

> **Dev loop** (fast; do not rebuild Docker to test a code change):
> ```bash
> docker compose up -d postgres          # Postgres only, container 5432 → host 5433
> cd app/backend  && pnpm dev            # tsx watch, ~1s reload, :3000
> cd app/frontend && pnpm dev            # Vite HMR, :5173  ← open THIS
> ```
> Open `http://localhost:5173`, not 3000 — Vite proxies the API so the session cookie stays same-origin. Docker rebuilds (`docker compose up -d --build`, then `http://localhost:3000`) verify the production path at the **end** of a phase.
>
> - **`.env` is at the repo root**, gitignored. `pnpm dev` reads it via `--env-file=../../.env`. `db:migrate` does **not**, so natively run `pnpm exec tsx --env-file=../../.env src/db/migrate.ts`; inside Docker the env is injected and bare `pnpm db:migrate` is correct.
> - **Native dev uses Postgres on `localhost:5433`**; inside Compose it is `postgres:5432`. Same database, different address.
> - **Port 5433 conflict:** a stale `sprout-postgres` container from the archived v1 build can still hold it. Check for that before debugging a Postgres startup failure.
> - **`curl` to localhost fails behind the corporate proxy** — use `curl --noproxy '*' http://127.0.0.1:3000/health`.
> - **pnpm, never npm.** `pnpm db:generate --name <change>` — **no `--` separator**; pnpm 11 passes it through literally and drizzle-kit rejects it.
> - Stop dev servers with **Ctrl+C**, not the terminal's X — `tsx watch` spawns a child that survives and holds :3000. To clear it (PowerShell): `Get-NetTCPConnection -LocalPort 3000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`
