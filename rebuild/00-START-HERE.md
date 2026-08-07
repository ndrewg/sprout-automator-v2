# 00 — START HERE (read this before anything else)

This `rebuild/` directory is a **complete, self-contained specification** for the Sprout Automator — every decision, contract, selector, and gotcha that was learned the hard way, written down so the implementer never has to guess.

You (the human) are the orchestrator. A coding model is the implementer. These docs are the shared source of truth between you.

> **Phases 0–3 and 4A are built.** These docs began as a from-scratch build plan for a local model; that build is done. Read **[`STATE.md`](./STATE.md)** first — it says what actually exists today. Phases 0–5 are now an **as-built record**; new work starts at phase 6 and [`BACKLOG.md`](./BACKLOG.md).

---

## What you are building (one sentence)

A **self-hosted, multi-tenant web service** where colleagues sign up, store their own Sprout HRHub + Gmail credentials (encrypted), and have their daily clock-in / clock-out run automatically on a per-user schedule — driven by an in-process scheduler, a headless browser, and IMAP-based OTP retrieval.

Full detail: [`01-PROJECT-BRIEF.md`](./01-PROJECT-BRIEF.md).

---

## How to use these documents

The always-on rules live in **[`AGENTS.md`](./AGENTS.md)** (opencode and Claude Code both auto-load it, at the repo root and here). You do not need to paste a system prompt — attach the phase file and go.

### The protocol

1. **Read [`STATE.md`](./STATE.md) first.** It is the only file that describes reality. Phase docs describe intent, and where they disagree, STATE.md wins and the phase file gets a correction note.
2. **One phase — or one lettered sub-step — at a time**, gated before advancing. Attach the phase file plus the reference files it lists under "Attach for this session."
3. **A gate is a command with an exit code.** `pnpm typecheck && pnpm test` passes or it doesn't. Checks needing a human are marked `[manual]`. This matters more than it sounds: asked "did the gate pass?", a model with no test to run will reason about whether the code *ought* to pass and answer yes. Give it something that can say no. See [`reference/testing-strategy.md`](./reference/testing-strategy.md).
4. **Prescribe, never brainstorm.** These docs deliberately state *the one correct way* to do each thing. If the model proposes an alternative ("should I use JWT instead of DB sessions?"), the answer is no — the decision is already made in [`02-DECISIONS-AND-ARCHITECTURE.md`](./02-DECISIONS-AND-ARCHITECTURE.md). Redirect it.
5. **Reproduce, don't regenerate, the brittle code.** The HRHub selectors, the encryption byte-format, and the OTP regex in `reference/` are copy-paste-ready and were paid for in debugging time. They get used **verbatim**.
6. **Fetch live docs, don't trust memory.** Much of this stack post-dates most training cutoffs. See [`reference/live-docs-and-mcp.md`](./reference/live-docs-and-mcp.md) — this rule survived the move to a bigger model unchanged, because a newer model is confidently wrong about a new library in exactly the same way an older one is.

---

## Model & runtime (opencode-go, via opencode)

Phases 0–3 were built by Claude Code and a local Qwen. Ongoing work runs on **opencode-go**, driven through **opencode**.

**Default model: DeepSeek V4 Flash.** It is strong on agentic coding for this kind of work, and its request quota is high enough that a long tool-calling loop never becomes the constraint — which matters, because every tool call spends a request, and a quota that looks generous per-hour disappears fast inside an agentic loop. Reserve **GLM-5.2** for a single genuinely hard question rather than a whole session; its quota does not survive sustained agentic use.

**The one thing the default model cannot do is see.** That is fine everywhere except one task:

- **HRHub markup drift.** When a run fails at the clock step, the screenshots in `data/screenshots/<userId>/<runId>/` are the only evidence of what changed. Hand those to a vision-capable model (Haiku is plenty; MiniMax M3 if you want it in-provider) together with `reference/hrhub-automation-playbook.md`, and ask what moved. This is a deliberate, human-triggered handoff — not something to route automatically.

Everything else is text-only **by design**: the gates are executable, so correctness is proved by exit codes rather than by looking at a screen. Keep coding turns free of images; it is cheaper and it is also more reliable.

### Driving this with opencode

opencode loads project rules from **`AGENTS.md`** (repo root, merging nested ones). Three things make this reliable:

1. **`AGENTS.md` is the always-on rules file** — the conventions, the async rule, the secrets rule, the live-docs rule, and the model-routing note, injected every turn. The root and `rebuild/` copies are kept byte-identical; edit one, copy to the other.
2. **Add the Context7 docs MCP.** In `opencode.json`, a `mcp` entry for Context7 (hosted `https://mcp.context7.com/mcp` or local `npx -y @upstash/context7-mcp`) lets the model fetch current React 19 / Tailwind 4 / Express 5 / shadcn / Drizzle / pnpm docs instead of emitting remembered ones. Config + per-phase fetch list: `reference/live-docs-and-mcp.md`.
3. **One phase (or sub-step) per session; gate before advancing.** Attach the single phase file, let it implement, then run the gate. A phase too big for one go is fed as its lettered sub-steps.
4. **Two skills for UI work, in distinct lanes** (phase-3 spells out usage): the **`shadcn` skill** is the authority for shadcn component work (init/add/docs/compose + styling rules; injects project context; v4-aware), and **`ui-ux-pro-max`** is for design decisions + `Platform: Web` responsive/UX review. Context7 covers everything else's docs. When they overlap on shadcn, the shadcn skill wins. The dashboard **must be responsive** — colleagues use it on phones — so apply ui-ux-pro-max's `Platform: Web` rules and skip its React-Native/native-only ones.

> **On trusting the model more than the last one:** a stronger model needs less hand-holding on *syntax* and exactly as much on *this project's specifics*. The verbatim reference blocks, the locked decisions, and the DO-NOT list are not scaffolding for a weak model — they encode bugs that already happened. Keep them.

---

## Map of this directory

Read the foundation docs in order once, then work the phases.

**Read first, every session:**
- [`STATE.md`](./STATE.md) — what is actually built, what is next, where the docs have drifted. **The phase files describe intent; this describes reality.**
- [`SESSION-PROMPT.md`](./SESSION-PROMPT.md) — copy-paste kickoff prompt for opencode, per role (implementer / reviewer / screenshot triage), plus the environment gotchas.
- [`AGENTS.md`](./AGENTS.md) — compact guardrail digest, auto-loaded every turn (hard rules + DO-NOT list).
- [`BACKLOG.md`](./BACKLOG.md) — ranked known-missing work that isn't yet a phase file.

**Foundation (read once, keep handy):**
1. [`01-PROJECT-BRIEF.md`](./01-PROJECT-BRIEF.md) — what & why, the whole system at a glance, the non-negotiables.
2. [`02-DECISIONS-AND-ARCHITECTURE.md`](./02-DECISIONS-AND-ARCHITECTURE.md) — every locked decision (the distilled ADRs), data model, request flows, and my recommended improvements.
3. [`03-CONVENTIONS-AND-GUARDRAILS.md`](./03-CONVENTIONS-AND-GUARDRAILS.md) — coding standards, the *prescriptive* patterns, and the DO-NOT list.
4. [`04-STACK-SCAFFOLD-AND-CONFIG.md`](./04-STACK-SCAFFOLD-AND-CONFIG.md) — exact dependency versions, every config file, scaffold commands.

**Phases (one feeding session each).** 0–3 and 4A are **built** — read them as an as-built record, don't re-run them:
- [`phases/phase-0-scaffold.md`](./phases/phase-0-scaffold.md) ✅
- [`phases/phase-1-db-auth-credentials.md`](./phases/phase-1-db-auth-credentials.md) ✅
- [`phases/phase-2-automation.md`](./phases/phase-2-automation.md) ✅
- [`phases/phase-3-frontend.md`](./phases/phase-3-frontend.md) ✅
- [`phases/phase-4-security.md`](./phases/phase-4-security.md) — 4A ✅ · **4A.2 signup gating** and 4B pending
- [`phases/phase-5-deploy-ops.md`](./phases/phase-5-deploy-ops.md) — pending
- [`phases/phase-T-test-harness.md`](./phases/phase-T-test-harness.md) — **next**: integration + e2e harness. Runs before 6; gates everything after it
- [`phases/phase-6-notifications.md`](./phases/phase-6-notifications.md) — Telegram run notifications + missed-run reconciliation
- [`phases/phase-7-schedule-pause.md`](./phases/phase-7-schedule-pause.md) — pause / leave days

**Reference (attach to a phase when it says so; reproduce these verbatim):**
- [`reference/testing-strategy.md`](./reference/testing-strategy.md) — **executable gates; attach to every phase from 6 onward**
- [`reference/database-schema.md`](./reference/database-schema.md)
- [`reference/api-contract.md`](./reference/api-contract.md)
- [`reference/hrhub-automation-playbook.md`](./reference/hrhub-automation-playbook.md)
- [`reference/crypto-and-otp-specs.md`](./reference/crypto-and-otp-specs.md)
- [`reference/supply-chain-and-ci.md`](./reference/supply-chain-and-ci.md) — pnpm 11 hardening, gitleaks, CI (attach to Phase 0)
- [`reference/live-docs-and-mcp.md`](./reference/live-docs-and-mcp.md) — **Context7 MCP setup + the "fetch current docs, don't guess" rule. Attach to EVERY phase** (the stack is newer than the model's training).

---

## The single most important lesson baked into these docs

The original build shipped a bug where the frontend mixed `mutate()` (fire-and-forget) with `await ... mutateAsync()` (promise-based) because the brief *showed both patterns without prescribing which to use where*. Given the choice, a model will take it — and both forms compile, both look idiomatic, and the broken one fails silently by showing "Saved." after a failed save. Model strength doesn't help here; only removing the choice does.

**So: these docs never present two options for the same decision.** They state the one correct pattern, show one correct example, and list the wrong pattern only under a "DO NOT" so the model can recognize and avoid it. Maintain that discipline when you extend them.
