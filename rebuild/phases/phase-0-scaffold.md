# Phase 0 — TypeScript Scaffold

**Goal:** a runnable Express + TypeScript backend that validates its env, exposes `/health`, and a Docker Compose file with Postgres. No features yet — just the skeleton everything else hangs on.

**Attach for this session:** `03-CONVENTIONS-AND-GUARDRAILS.md`, `04-STACK-SCAFFOLD-AND-CONFIG.md`, `reference/supply-chain-and-ci.md`.

**Prerequisite checks:** Node **22+**, Docker, Docker Compose installed. Enable pnpm once: `corepack enable pnpm` (then `pnpm --version` → 11.x).

---

## Steps

### 0.1 — Create the repo skeleton
```
sprout-automator/
├── .gitignore
├── .env.example                # from 04 (verbatim)
├── .pre-commit-config.yaml      # gitleaks — from supply-chain ref
├── .github/workflows/ci.yml     # typecheck+test+audit — from supply-chain ref
├── docker-compose.yml           # from 04 (verbatim)
└── app/backend/
    ├── package.json             # from 04 (verbatim; pnpm packageManager)
    ├── pnpm-workspace.yaml       # supply-chain settings — from supply-chain ref
    ├── tsconfig.json            # from 04 (verbatim)
    └── src/
        ├── config.ts            # from 04 (verbatim)
        ├── lib/logger.ts        # pino (this phase — see 0.3)
        └── index.ts             # this phase
```

`.gitignore` must include at least (note: **`pnpm-lock.yaml` is committed**, not ignored):
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

**Structured logging is in from the start** (`pino` is in the dependency list): create `src/lib/logger.ts` exporting a configured `pino` instance with a `redact` list (`['req.headers.cookie','password','appPassword','gmailAppPassword','code','otp','sid','APP_ENCRYPTION_KEY','SESSION_SECRET']`), and use it in `index.ts` (and `pino-http` for request logging with a `requestId`) instead of `console.log`. The redact list is how the "never log secrets" rule (§03) is enforced mechanically.

### 0.4 — `docker-compose.yml` + `.env`
- Copy `docker-compose.yml` and `.env.example` from `04` verbatim (Postgres is `postgres:18-alpine`).
- `cp .env.example .env` and fill `APP_ENCRYPTION_KEY` (64 hex chars) and `SESSION_SECRET` (≥32 chars) using the commands in the file's comments. **Generate fresh secrets — do not reuse any from a prior build.**

### 0.5 — Supply-chain setup (do this BEFORE installing deps) — see `reference/supply-chain-and-ci.md`
- Create `app/backend/pnpm-workspace.yaml` with `minimumReleaseAge` + `allowBuilds` (esbuild, @node-rs/argon2, playwright) exactly as in the supply-chain reference.
- Create `.pre-commit-config.yaml` (gitleaks) and install: `pre-commit install` → run `pre-commit run --all-files` (must be clean).
- Create `.github/workflows/ci.yml` (typecheck + test + `pnpm audit`).

### 0.6 — Install & typecheck (pnpm)
```bash
cd app/backend && pnpm install && pnpm typecheck
```
If `pnpm install` errors about a blocked build script, that's `strictDepBuilds` working — add the named package to `allowBuilds` only if it's a trusted build dep (esbuild/argon2/playwright), never blanket-allow.

---

## Verification Gate (must pass before Phase 1)

1. `cd app/backend && pnpm typecheck` → no errors.
2. Start Postgres + run the backend natively:
   ```bash
   docker compose up -d postgres
   cd app/backend && pnpm dev
   ```
3. `curl http://localhost:3000/health` → JSON with `"status":"ok"`.
4. Break the env on purpose (e.g. blank `APP_ENCRYPTION_KEY` in `.env`) and confirm the process **refuses to start** with a readable `Invalid environment configuration:` message. Restore the env after.
5. **Supply-chain checks:** `pnpm-lock.yaml` exists and is committed; `pre-commit run --all-files` is clean (gitleaks finds no secrets); the CI workflow file is present.

If all four pass, Phase 0 is done (single gate = single commit). Commit `feat(phase-0): typescript scaffold + health + compose`, then tag `git tag phase-0-complete`. (Reminder: *you* run the commit, not the agent — only on a green gate.)
