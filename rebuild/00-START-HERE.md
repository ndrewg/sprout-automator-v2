# 00 — START HERE (read this before anything else)

This `rebuild/` directory is a **complete, self-contained specification** for rebuilding the Sprout Automator from scratch. It exists so that a local LLM (running on consumer hardware) can implement the entire project **without losing the plot** — every decision, contract, selector, and gotcha that was learned the hard way is written down here so the model never has to guess.

You (the human) are the orchestrator. The LLM is the implementer. These docs are the shared source of truth between you.

---

## What you are building (one sentence)

A **self-hosted, multi-tenant web service** where colleagues sign up, store their own Sprout HRHub + Gmail credentials (encrypted), and have their daily clock-in / clock-out run automatically on a per-user schedule — driven by an in-process scheduler, a headless browser, and IMAP-based OTP retrieval.

Full detail: [`01-PROJECT-BRIEF.md`](./01-PROJECT-BRIEF.md).

---

## How to use these documents with a local LLM

Local models are not frontier models. They have shorter *usable* context (quality degrades long before the advertised window fills), weaker instruction-following, and they drift over long generations. These docs are engineered around that reality. **Follow this protocol:**

### The golden protocol

1. **One phase per session.** Never paste the whole `rebuild/` directory and say "build it." Start a fresh chat for each phase. Feed only:
   - This file's **§ Paste-in system prompt** (every session, at the top).
   - The **single phase file** you're working on (`phases/phase-N-*.md`).
   - Only the **reference files that phase explicitly lists** under "Attach these."
2. **Build, then gate, then advance.** Each phase ends with a **Verification Gate** — concrete commands and expected output. Do not start phase N+1 until phase N's gate passes. If the gate fails, paste the error back into the *same* session and iterate.
3. **Prescribe, never brainstorm.** These docs deliberately state *the one correct way* to do each thing. If the model proposes an alternative ("should I use JWT instead of DB sessions?"), the answer is no — the decision is already made in [`02-DECISIONS-AND-ARCHITECTURE.md`](./02-DECISIONS-AND-ARCHITECTURE.md). Redirect it.
4. **Reproduce, don't regenerate, the brittle code.** The HRHub selectors, the encryption byte-format, and the OTP regex in `reference/` are copy-paste-ready and were paid for in debugging time. Tell the model to **use them verbatim**, not to invent its own.
5. **Keep fed context small.** Even though some models advertise 128k–256k windows, on a quantized local model you want to keep each session's working context well under ~32k tokens for reliable output. The per-phase decomposition is what makes that possible — respect it.

### Paste-in system prompt (use at the top of EVERY session)

> You are a senior TypeScript engineer implementing one phase of a pre-designed project called Sprout Automator. All architectural decisions are already made and provided to you in the attached specification — do not propose alternatives, do not redesign, do not "improve" the stack. Your job is to produce correct, complete, copy-paste-ready code that matches the contracts in the spec exactly.
>
> Hard rules:
> - TypeScript only, ESM (`"type": "module"`). `moduleResolution` is **Bundler** — **do NOT add `.js` extensions** to relative imports. The code is run directly with `tsx`; there is no compile step for the backend.
> - All sequential async logic uses `async`/`await` with `try/catch`. **Never use `.then().catch()` for control flow.** The only `.catch()` allowed is the three contained idioms documented in the spec (Playwright best-effort probes, fire-and-forget cleanup, the top-level `main().catch`) — reproduce those verbatim, never generalize them.
> - Use the exact file paths, function names, table names, and API shapes given in the spec. Do not rename them.
> - Reproduce any code block the spec marks "copy verbatim" exactly. Do not refactor it.
> - When a spec section says a value is fixed (a selector, a regex, a byte layout, a cron expression), treat it as fixed.
> - Never log, echo, or put secrets (passwords, app passwords, OTP codes, encryption keys, session ids) into responses, error messages, or audit metadata.
> - If something is ambiguous or missing from the spec, STOP and ask me one specific question rather than inventing an answer.
>
> Output format: for each file you create or change, give the full file path as a heading and the complete file contents in a single code block. Do not abbreviate with "// ... rest unchanged".

Adjust the wording to taste, but keep the hard rules — every one of them maps to a bug that already happened or a decision that's already locked.

---

## Your model & runtime (Qwen3.6-35B-A3B-MTP @ 128k, via opencode)

Your setup: **Qwen3.6-35B-A3B-MTP (Unsloth UD-IQ4_NL)** on a **Ryzen 7 9800X3D + RTX 5070 Ti (16 GB) + 32 GB DDR5-6000**, served by `llama-server` with `--fit-ctx 128000`, `q8_0` KV cache, MTP speculative decoding (`--spec-type draft-mtp --spec-draft-n-max 4`), and Qwen's recommended thinking-mode sampling (`temp 0.6 / top-p 0.95 / top-k 20 / min-p 0`). You drive it through **opencode**. This is a perfectly good agentic MoE for this work, and your launch config is well-tuned — these docs are written to play to its strengths, not to push you off it.

What that setup means for *how* you run these phases:

- **You have 128k context, but don't fill it.** Quality on a quantized local model degrades well before the window is full, and `q8_0` KV at 128k is already a lot of cache. The per-phase design keeps each session's *real* working set to roughly 8–25k tokens (one phase file + 1–3 reference files + the conventions). That is deliberate — it leaves the model plenty of headroom for its own reasoning (`--reasoning-budget -1`) and for opencode's tool/file context, which accumulates across turns.
- **MTP speculative decoding rewards predictable, idiomatic code** — which is exactly what the "reproduce verbatim" reference blocks and the prescriptive conventions produce. Drafts are accepted more often when the target distribution is sharp, so the more the model is steered to *the one correct pattern*, the faster it runs. The async/await mandate and the DO-NOT list help here too.
- **Keep the thinking-mode sampling as-is.** `temp 0.6 / top-p 0.95 / top-k 20` is Qwen's official recommendation for reasoning mode and is correct for this — don't drop the temperature to 0 chasing determinism; it hurts this model's reasoning. Determinism comes from the spec being unambiguous, not from the sampler.
- **The vision projector (`mmproj`) is a bonus.** Since the model can see images, in Phase 2 you can paste a screenshot from `data/screenshots/<userId>/<runId>/` when an HRHub step misbehaves and ask it to compare against the selectors in the playbook.

### Driving this with opencode

opencode loads project rules from **`AGENTS.md`** files (it reads them at the project root and merges nested ones). Two things make the rebuild reliable through opencode:

1. **Use `rebuild/AGENTS.md` as the always-on rules file.** It's a compact digest of the conventions + the DO-NOT list + the async rule, written so opencode injects it into every turn automatically. When you run a rebuild session, work with your cwd at `rebuild/` (or copy its contents into the repo-root `AGENTS.md`) so opencode always has the guardrails in context — you then only need to *attach the phase file* for that session.
2. **One phase per opencode session; gate before advancing.** Start a fresh session per phase, point it at the single `phases/phase-N-*.md`, let it implement, then run that phase's **Verification Gate**. Don't let opencode roam the whole repo per turn — the decomposition is what keeps the model from drifting. If a phase is too big in one go, feed its numbered sub-steps (e.g. `2A`, `2B`, …) as separate turns.

> If you ever want a second opinion on a tricky multi-file step, a coder-tuned sibling (e.g. Qwen3-Coder-30B-A3B-Instruct) can be swapped in for that session — but it's optional. Your current model handles these phases fine given the spec does the heavy lifting.

- **Don't fight the hardware.** If the model starts truncating or hallucinating file contents, the session context is too big — split the phase into its numbered sub-steps and feed them one at a time. Smaller, sharper context beats a bigger window every time on local quant.

---

## Map of this directory

Read the foundation docs in order once, then work the phases.

**Always-on rules:**
- [`AGENTS.md`](./AGENTS.md) — compact guardrail digest opencode auto-loads every turn (hard rules + DO-NOT list). Keep it in context for every session.

**Foundation (read once, keep handy):**
1. [`01-PROJECT-BRIEF.md`](./01-PROJECT-BRIEF.md) — what & why, the whole system at a glance, the non-negotiables.
2. [`02-DECISIONS-AND-ARCHITECTURE.md`](./02-DECISIONS-AND-ARCHITECTURE.md) — every locked decision (the distilled ADRs), data model, request flows, and my recommended improvements.
3. [`03-CONVENTIONS-AND-GUARDRAILS.md`](./03-CONVENTIONS-AND-GUARDRAILS.md) — coding standards, the *prescriptive* patterns, and the DO-NOT list.
4. [`04-STACK-SCAFFOLD-AND-CONFIG.md`](./04-STACK-SCAFFOLD-AND-CONFIG.md) — exact dependency versions, every config file, scaffold commands.

**Phases (one feeding session each):**
- [`phases/phase-0-scaffold.md`](./phases/phase-0-scaffold.md)
- [`phases/phase-1-db-auth-credentials.md`](./phases/phase-1-db-auth-credentials.md)
- [`phases/phase-2-automation.md`](./phases/phase-2-automation.md)
- [`phases/phase-3-frontend.md`](./phases/phase-3-frontend.md)
- [`phases/phase-4-security.md`](./phases/phase-4-security.md)
- [`phases/phase-5-deploy-ops.md`](./phases/phase-5-deploy-ops.md)

**Reference (attach to a phase when it says so; the LLM reproduces these verbatim):**
- [`reference/database-schema.md`](./reference/database-schema.md)
- [`reference/api-contract.md`](./reference/api-contract.md)
- [`reference/hrhub-automation-playbook.md`](./reference/hrhub-automation-playbook.md)
- [`reference/crypto-and-otp-specs.md`](./reference/crypto-and-otp-specs.md)

---

## The single most important lesson baked into these docs

The original build shipped a bug where the frontend mixed `mutate()` (fire-and-forget) with `await ... mutateAsync()` (promise-based) because the brief *showed both patterns without prescribing which to use where*. A local model will make that mistake ten times out of ten if you give it the chance.

**So: these docs never present two options for the same decision.** They state the one correct pattern, show one correct example, and list the wrong pattern only under a "DO NOT" so the model can recognize and avoid it. Maintain that discipline when you extend them.
