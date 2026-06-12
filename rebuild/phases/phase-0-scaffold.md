# Phase 0 — TypeScript Scaffold

**Goal:** a runnable Express + TypeScript backend that validates its env, exposes `/health`, and a Docker Compose file with Postgres. No features yet — just the skeleton everything else hangs on.

**Attach for this session:** `03-CONVENTIONS-AND-GUARDRAILS.md`, `04-STACK-SCAFFOLD-AND-CONFIG.md`.

**Prerequisite checks:** Node 20+, Docker, Docker Compose installed.

---

## Steps

### 0.1 — Create the repo skeleton
```
sprout-automator/
├── .gitignore
├── .env.example          # from 04 (verbatim)
├── docker-compose.yml     # from 04 (verbatim)
└── app/backend/
    ├── package.json       # from 04 (verbatim)
    ├── tsconfig.json      # from 04 (verbatim)
    └── src/
        ├── config.ts      # from 04 (verbatim)
        └── index.ts       # this phase
```

`.gitignore` must include at least:
```
node_modules/
.env
app/backend/data/
app/backend/dist/
app/backend/public/
*.log
```

### 0.2 — `src/config.ts`
Copy verbatim from `04`. It Zod-validates `process.env` and exports a frozen `config`. The process must **fail to start** with a clear message if any required env var is missing/invalid.

### 0.3 — `src/index.ts` (Phase 0 version — health only)
Build a minimal Express app that:
- `app.set("trust proxy", 1)`
- `app.use(express.json({ limit: "100kb" }))`
- `GET /health` → `{ status:"ok", service:"sprout-automator-backend", version:"0.0.0", db:"ok"|"down", timestamp }`. In Phase 0 there's no DB yet, so report `db:"down"` or omit the DB check — it becomes real in Phase 1. (Simplest: wrap a `select 1` in try/catch once the DB client exists; for now hardcode `db:"ok"` is acceptable, it gets replaced in Phase 1.)
- a global JSON error handler (logs, responds `500 {"error":"Internal server error"}`, no stack trace)
- `app.listen(config.PORT, "0.0.0.0", ...)` with a startup log line.

Keep it tiny. Do not add routers, DB, or auth yet.

> ⚑ RECOMMENDED (improvement #1): introduce `pino` now instead of `console.log`. Add `pino` + `pino-http` to deps, create `src/lib/logger.ts` exporting a configured `pino` instance with a `redact` list (`['req.headers.cookie','password','appPassword','code','otp']`), and use it in `index.ts`. If you skip this, use `console.log`/`console.error` and revisit later.

### 0.4 — `docker-compose.yml` + `.env`
- Copy `docker-compose.yml` and `.env.example` from `04` verbatim.
- `cp .env.example .env` and fill `APP_ENCRYPTION_KEY` (64 hex chars) and `SESSION_SECRET` (≥32 chars) using the commands in the file's comments.

### 0.5 — Install & typecheck
```bash
cd app/backend && npm install && npm run typecheck
```

---

## Verification Gate (must pass before Phase 1)

1. `cd app/backend && npm run typecheck` → no errors.
2. Start Postgres + run the backend natively:
   ```bash
   docker compose up -d postgres
   cd app/backend && npm run dev
   ```
3. `curl http://localhost:3000/health` → JSON with `"status":"ok"`.
4. Break the env on purpose (e.g. blank `APP_ENCRYPTION_KEY` in `.env`) and confirm the process **refuses to start** with a readable `Invalid environment configuration:` message. Restore the env after.

If all four pass, Phase 0 is done (single gate = single commit). Commit `feat(phase-0): typescript scaffold + health + compose`, then tag `git tag phase-0-complete`. (Reminder: *you* run the commit, not the agent — only on a green gate.)
