# CLAUDE.md

This is the **Sprout Automator v2 rebuild**. Build target = this directory.

**Always follow the guardrails in @AGENTS.md**, and start from `rebuild/00-START-HERE.md`.

## Build context
- **Builder:** Claude Code first (on enterprise tokens), then hand off to **opencode** + the local model when those run out. Both use the same `rebuild/` spec.
- **Stack (latest):** TypeScript ESM + `tsx` (no compile, Bundler resolution, no `.js` extensions), Express 5, PostgreSQL 18, Drizzle, Playwright 1.60, Node 22, **pnpm 11**; frontend React 19 + Tailwind 4 + shadcn-latest + Vite 6 + TanStack Query v5. Fresh DB / fresh secrets.
- **How to build:** one phase at a time from `rebuild/phases/phase-0 … phase-5`, each gated by its Verification Gate; commit on each green gate. Decisions: `rebuild/02-DECISIONS-AND-ARCHITECTURE.md`; conventions + DO-NOT list: `rebuild/03-CONVENTIONS-AND-GUARDRAILS.md`.
- **Post-cutoff stack → fetch current docs:** use Context7 (and the `shadcn` + `ui-ux-pro-max` skills for Phase 3) rather than relying on training memory. See `rebuild/reference/live-docs-and-mcp.md`.
- **`_archive/` is reference-only** (stale prior build + secrets) — gitignored; never read it to decide how to build or copy from it.
