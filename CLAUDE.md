# CLAUDE.md

This is the **Sprout Automator v2 rebuild**. Build target = this directory.

**Always follow the guardrails in @AGENTS.md.** Read `rebuild/STATE.md` **first** — it says what is actually built; the phase files describe intent and can lag. Then `rebuild/00-START-HERE.md` for the session protocol.

## Build context
- **Builder:** phases 0–3 + 4A were built by Claude Code and a local Qwen. Ongoing work runs on **opencode-go** via opencode (default **DeepSeek V4 Flash**; hand HRHub screenshot triage to a vision-capable model — see `00-START-HERE.md` § Model & runtime). Same `rebuild/` spec throughout.
- **Gates are executable** from phase 6 on: `pnpm typecheck && pnpm test`. Human-only checks are marked `[manual]`. Never report a gate green because the code looks right — see `rebuild/reference/testing-strategy.md`.
- **Stack (latest):** TypeScript ESM + `tsx` (no compile, Bundler resolution, no `.js` extensions), Express 5, PostgreSQL 18, Drizzle, Playwright 1.60, Node 22, **pnpm 11**; frontend React 19 + Tailwind 4 + shadcn-latest + **Vite 8 + TypeScript 6** + TanStack Query v5. (`04-STACK-SCAFFOLD-AND-CONFIG.md` still says Vite 6 in places — see `BACKLOG.md` § 10.) Fresh DB / fresh secrets.
- **How to build:** one phase at a time, **in the order given by the queue table at the top of `rebuild/STATE.md`** — that table is the authority, not the phase numbers on disk. Each phase is gated by its Verification Gate; commit on green. Phases 0–14 are done (code); what remains is 15 → 17. `rebuild/TAGS.md` says what each untagged phase still needs from you.
- **The loop is four opencode agents** in `.opencode/agent/`: `coder` (DeepSeek V4 Flash) → `tester` (MiMo-V2.5) → `reviewer` (Hy3, and the only one that commits), driven by `orchestrator` (Hy3, writes nothing). Permissions enforce the split — the coder and tester have read-only git. Roles and prompts: `rebuild/SESSION-PROMPT.md`. Decisions: `rebuild/02-DECISIONS-AND-ARCHITECTURE.md`; conventions + DO-NOT list: `rebuild/03-CONVENTIONS-AND-GUARDRAILS.md`.
- **Post-cutoff stack → fetch current docs:** use Context7 (and the `shadcn` + `ui-ux-pro-max` skills for Phase 3) rather than relying on training memory. See `rebuild/reference/live-docs-and-mcp.md`.
- **`_archive/` is reference-only** (stale prior build + secrets) — gitignored; never read it to decide how to build or copy from it.
