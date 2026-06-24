# Reference — Live Docs for Post-Cutoff Stack (Context7 / MCP)

**The problem this solves.** This build targets the **latest** stack — React 19, Tailwind 4, Express 5, shadcn-latest, Playwright 1.60, PostgreSQL 18, Drizzle, pnpm 11 — but a local model's **training cutoff may predate most of it** (React 19 = Dec 2024, Tailwind 4 = Jan 2025, Express 5 default = Mar 2025, pnpm 11, PG 18, Playwright 1.60 are all 2025–2026). A model that never saw these will confidently emit **stale, wrong APIs** (v3 Tailwind config, Express-4 patterns, React-18 types, npm instead of pnpm).

**The fix:** give the model a live-documentation tool and make it a *rule* to consult current docs for any post-cutoff library **before** writing that code — not guess from training. Attach this file to **every** phase.

---

## The rule (put this in front of the model every session)

> Before writing code against any of these libraries, call the docs MCP (Context7) to fetch the **current, version-specific** API — do not rely on training memory: **React 19, react-dom, Tailwind CSS v4 (`@tailwindcss/vite`, `@theme`), shadcn/ui (latest), Express 5, Drizzle ORM + drizzle-kit, Zod, @tanstack/react-query v5, Playwright 1.60, pnpm 11 (`allowBuilds`, `minimumReleaseAge`), node-cron, imapflow, pino.** If the docs contradict what you "remember," the docs win. If no docs tool is available, STOP and ask rather than emit a guessed API.

The reference code blocks in the other `rebuild/reference/*` files are already correct for these versions — **reproduce those verbatim**. Use live docs for everything *not* pinned in those files (especially the Tailwind 4 setup, React 19 types, shadcn CLI output, and any API the model is unsure of).

---

## Context7 — setup in opencode

Context7 (by Upstash) is an MCP server that fetches up-to-date, version-specific docs and injects them into context. Two tools: **`resolve-library-id`** (free-text name → a `/org/project` id with version) and **`get-library-docs`** (id → current doc snippets). You must `resolve-library-id` first unless you already have the `/org/project` id. It caps at ~3 doc calls per question by default.

Add it to opencode's config (`opencode.json` at the repo root or `~/.config/opencode/opencode.json`), under the `mcp` key.

**Option A — hosted (recommended; needs a free Context7 API key):**
```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "context7": {
      "type": "remote",
      "url": "https://mcp.context7.com/mcp",
      "enabled": true,
      "headers": { "CONTEXT7_API_KEY": "<your-key>" }
    }
  }
}
```

**Option B — local npm (no key, lower rate limits):**
```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "context7": {
      "type": "local",
      "command": ["npx", "-y", "@upstash/context7-mcp"],
      "enabled": true
    }
  }
}
```

After adding it, the `resolve-library-id` / `get-library-docs` tools appear to the model automatically alongside opencode's built-ins.

### How the model should use it (example)
```
1. resolve-library-id "tailwindcss v4"   → /tailwindlabs/tailwindcss (v4.x)
2. get-library-docs  /tailwindlabs/tailwindcss  topic: "vite plugin, @theme, installation"
3. …now write the v4 setup from the returned docs, not from memory.
```
If you already know the id (e.g. `/vercel/next.js`), you can skip step 1.

---

## What to fetch, per phase

Pull docs for the phase's key libraries at the **start** of the session (before writing). Suggested resolves:

| Phase | Fetch current docs for |
|-------|------------------------|
| 0 — scaffold | **pnpm 11** (`allowBuilds`, `minimumReleaseAge`, `pnpm-workspace.yaml`), **Express 5** (app setup, async error handling), **pino** / **pino-http**, **tsx** |
| 1 — db/auth/creds | **Drizzle ORM + drizzle-kit** (current schema DSL, `pgTable`, partial/unique indexes, migrate), **Zod**, **@node-rs/argon2**, **cookie-parser** w/ Express 5 |
| 2 — automation | **Playwright 1.60** (locators, `storageState`, `chromium.launch`), **imapflow**, **mailparser**, **node-cron**, **date-holidays** |
| 3 — frontend | **React 19** (types: `useRef`, `JSX`, no implicit children), **Tailwind CSS v4** (`@tailwindcss/vite`, `@import "tailwindcss"`, `@theme`), **shadcn/ui** (latest CLI, `init`, `add`, Tailwind-v4 mode), **@tanstack/react-query v5**, **Vite 5/6** |
| 4 — security | **helmet** (current CSP API), **express-rate-limit v7**, (if email) the chosen mail SDK |
| 5 — deploy | **Caddy** v2, **Docker Compose**, **pnpm** in Docker |

---

## Fallbacks (if Context7 is unavailable)

1. **opencode's built-in web tools / WebFetch** — fetch the library's official docs page or its `llms.txt` (many projects now publish `https://<docs-site>/llms.txt` or `llms-full.txt` for exactly this).
2. The library's **GitHub releases / CHANGELOG** for the target version (e.g. the Express 5, Tailwind 4, pnpm 11 release notes).
3. A **skill/rule** in opencode that hardcodes "always consult docs for X" — encode the rule above as an always-on instruction (it's also in `AGENTS.md`).
4. **Last-resort fallback stack:** if you genuinely cannot give the model live docs, drop the frontend to **React 18 + Tailwind 3** (which a late-2024 model knows natively) and keep the backend as specced — Express 5 / Drizzle / Playwright are close enough to their training that the verbatim reference code carries them. This is a degradation, not the plan; prefer the docs tool.

---

## Why this beats pinning to old versions
Pinning the frontend to React 18 / Tailwind 3 (the earlier plan) dodged the cutoff but locked you to aging libraries. Live docs let you ship the **current** stack *and* keep using your existing local model — the model's missing knowledge is supplied just-in-time, per library, per phase. It also future-proofs: when the next major lands, you fetch its docs instead of waiting for a model that was trained on it.
