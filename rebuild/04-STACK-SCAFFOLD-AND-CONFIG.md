# 04 — Stack, Scaffold & Config

Exact dependency versions and the full contents of every config file. The LLM should reproduce these **verbatim** — versions are pinned where a bump could change behavior (Playwright especially).

> **Stack decisions locked for this build (June 2026) — LATEST across the board:** Express **5**, PostgreSQL **18**, Playwright **1.60.0**, Node **22**, **pnpm 11** (supply-chain hardening — `reference/supply-chain-and-ci.md`), and the **latest frontend**: **React 19 + Tailwind CSS v4 + shadcn-latest + Vite 6 + TanStack Query v5**. Deploy target is a **4 GB** Hetzner CPX21.
>
> ⚠️ **Most of this stack is post-cutoff for a late-2024 local model.** The model must **fetch current docs at build time via Context7 (MCP)** rather than emit remembered (stale) APIs — this is how we run the latest stack on an older model. See `reference/live-docs-and-mcp.md`; it's attached to every phase.

---

## Repo layout (target)

```
sprout-automator/
├── docker-compose.yml
├── docker-compose.prod.yml        # Caddy overlay (Phase 5)
├── Caddyfile                      # (Phase 5)
├── .env.example                   # committed; real .env is gitignored
├── .gitignore                     # must exclude .env, node_modules, data/, dist/, public/
├── .pre-commit-config.yaml        # gitleaks hook (Phase 0; supply-chain ref)
├── .github/workflows/ci.yml       # typecheck + test + audit (Phase 0; supply-chain ref)
├── DEPLOY.md
└── app/
    ├── backend/
    │   ├── package.json
    │   ├── pnpm-workspace.yaml     # pnpm 11 supply-chain settings (minimumReleaseAge, allowBuilds)
    │   ├── pnpm-lock.yaml          # committed; installs use --frozen-lockfile
    │   ├── tsconfig.json
    │   ├── drizzle.config.ts
    │   ├── Dockerfile
    │   ├── drizzle/               # generated migrations (committed)
    │   └── src/                   # see module layout in 02
    └── frontend/
        ├── package.json
        ├── pnpm-workspace.yaml     # pnpm 11 supply-chain settings
        ├── pnpm-lock.yaml
        ├── tsconfig.json
        ├── vite.config.ts          # includes @tailwindcss/vite (Tailwind v4)
        ├── components.json         # shadcn config (written by `shadcn init`)
        ├── index.html
        └── src/
            └── index.css           # Tailwind v4: @import "tailwindcss" + @theme (NO tailwind.config.js / postcss.config.js)
```

The Docker **build context is `./app`** (so the Dockerfile sees `frontend/` and `backend/`).

---

## Backend `package.json` (exact)

```json
{
  "name": "sprout-automator-backend",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "packageManager": "pnpm@11.0.0",
  "scripts": {
    "dev": "tsx watch --env-file=../../.env src/index.ts",
    "start": "tsx src/index.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "tsx src/db/migrate.ts",
    "db:studio": "drizzle-kit studio"
  },
  "dependencies": {
    "@node-rs/argon2": "^2.0.0",
    "cookie-parser": "^1.4.7",
    "date-holidays": "^3.23.12",
    "drizzle-orm": "^0.36.0",
    "express": "^5.1.0",
    "express-rate-limit": "^7.4.1",
    "helmet": "^8.0.0",
    "imapflow": "^1.3.3",
    "mailparser": "^3.7.2",
    "node-cron": "^3.0.3",
    "pg": "^8.13.0",
    "pino": "^9.5.0",
    "pino-http": "^10.3.0",
    "playwright": "1.60.0",
    "tsx": "^4.19.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/cookie-parser": "^1.4.7",
    "@types/express": "^5.0.0",
    "@types/mailparser": "^3.4.5",
    "@types/node": "^22.0.0",
    "@types/node-cron": "^3.0.11",
    "@types/pg": "^8.11.0",
    "drizzle-kit": "^0.28.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

Notes:
- **`playwright` is pinned exactly to `1.60.0`** (no caret). It must match the Playwright Docker base image tag `v1.60.0-noble`. If you bump one, bump both.
- **Express is v5** (`^5.1.0`), `@types/express` `^5.0.0`. Express 5 **awaits async route handlers and forwards rejected promises to the error middleware** — so a `throw` inside an `async` handler now reaches the global error handler (in Express 4 it would crash the process as an unhandled rejection). You still validate with Zod and respond explicitly; this just makes the "never throw across the boundary unhandled" rule actually hold. The catch-all SPA route uses a **regex** (not a `*` string), which is compatible with Express 5's routing changes.
- **`pino` + `pino-http`** are now in (adopted improvement #1) — structured logging with a secret-redaction list. See `reference/supply-chain-and-ci.md` and `03` for the redaction keys.
- **`vitest`** is in for the pure-function tests (adopted improvement #2).
- **`@types/node` is `^22`** (Node 22 LTS).
- This is installed with **pnpm**, not npm — see `reference/supply-chain-and-ci.md` for the `pnpm-workspace.yaml` (supply-chain settings) that lives next to this file, and `corepack enable pnpm` first.

## Backend `tsconfig.json` (exact)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "allowImportingTsExtensions": true
  },
  "include": ["src/**/*", "drizzle.config.ts"],
  "exclude": ["node_modules", "dist"]
}
```

## Backend `drizzle.config.ts` (exact)

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env["DATABASE_URL"] ?? "postgres://localhost:5432/placeholder",
  },
  strict: true,
  verbose: true,
});
```

## Backend `Dockerfile` (exact — pnpm, Node 22, Playwright 1.60)

```dockerfile
# Build context is ./app. Frontend build stage → ./public for the backend.
# Debian (bookworm-slim), NOT alpine: Tailwind v4's native engine (Oxide/
# lightningcss) has musl/alpine friction — glibc avoids it.
FROM node:22-bookworm-slim AS frontend
WORKDIR /fe
RUN corepack enable pnpm
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend ./
RUN pnpm build

# Runtime — Playwright base image (tag MUST match the pinned playwright npm version).
# We run TypeScript directly with tsx; no separate compile step.
FROM mcr.microsoft.com/playwright:v1.60.0-noble
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable pnpm
COPY backend/package.json backend/pnpm-lock.yaml backend/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY backend/tsconfig.json ./
COPY backend/src ./src
COPY backend/drizzle ./drizzle
COPY backend/drizzle.config.ts ./
COPY --from=frontend /fe/dist ./public

RUN mkdir -p /app/data && chown -R pwuser:pwuser /app/data /app/public
USER pwuser

EXPOSE 3000
CMD ["pnpm", "exec", "tsx", "src/index.ts"]
```

> Note: the frontend build stage is **Debian** (`node:22-bookworm-slim`), not Alpine, because Tailwind v4's native engine (Oxide/lightningcss) has musl friction on Alpine. The runtime stage is the Playwright Debian image already.

---

## `docker-compose.yml` (exact, dev/base)

```yaml
services:
  postgres:
    image: postgres:18-alpine
    container_name: sprout-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-sprout}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-sprout_dev_pw}
      POSTGRES_DB: ${POSTGRES_DB:-sprout}
    ports:
      - "${POSTGRES_PORT:-5432}:5432"
    volumes:
      - sprout-pgdata:/var/lib/postgresql/data
    healthcheck:
      test:
        [
          "CMD-SHELL",
          "pg_isready -U ${POSTGRES_USER:-sprout} -d ${POSTGRES_DB:-sprout}",
        ]
      interval: 5s
      timeout: 5s
      retries: 10
    networks:
      - sprout-net

  backend:
    build:
      context: ./app
      dockerfile: ./backend/Dockerfile
    container_name: sprout-backend
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      NODE_ENV: ${NODE_ENV:-development}
      PORT: 3000
      DATABASE_URL: postgres://${POSTGRES_USER:-sprout}:${POSTGRES_PASSWORD:-sprout_dev_pw}@postgres:5432/${POSTGRES_DB:-sprout}
      APP_ENCRYPTION_KEY: ${APP_ENCRYPTION_KEY}
      SESSION_SECRET: ${SESSION_SECRET}
      DATA_DIR: /app/data
      SPROUT_URL: ${SPROUT_URL:-https://kmcsolutions.hrhub.ph/}
      TZ: ${TZ:-Asia/Manila}
    ports:
      - "${BACKEND_PORT:-3000}:3000"
    volumes:
      - sprout-backend-data:/app/data
    networks:
      - sprout-net

volumes:
  sprout-pgdata:
  sprout-backend-data:

networks:
  sprout-net:
    driver: bridge
```

## `.env.example` (exact)

```ini
# Copy to .env and fill in. Never commit the real .env.

# Runtime
NODE_ENV=development
BACKEND_PORT=3000

# PostgreSQL
POSTGRES_USER=sprout
POSTGRES_PASSWORD=sprout_dev_pw
POSTGRES_DB=sprout
POSTGRES_PORT=5432

# App secrets
# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
APP_ENCRYPTION_KEY=replace_me_with_64_hex_chars_from_the_command_above_xxxxxxxxxxxxxx

# Generate with: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
SESSION_SECRET=replace_me_with_a_long_random_string_at_least_32_chars

# Optional: native-dev DATABASE_URL (points at the host-mapped Postgres port).
# Docker Compose ignores this and injects its own postgres:5432 URL.
# DATABASE_URL=postgres://sprout:sprout_dev_pw@localhost:5433/sprout
```

> **Native-dev vs Docker `DATABASE_URL`:** in the local fast-loop (Postgres in Docker, backend native via `tsx watch`), map the Postgres container's 5432 to a host port (e.g. **5433**) and set `DATABASE_URL=…@localhost:5433/sprout` in `.env`. Inside Compose the backend uses `postgres:5432` (Compose injects it, overriding the file). Same database, different address — don't confuse them.

---

## Config validation: `src/config.ts` (exact — Phase 0)

```ts
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  APP_ENCRYPTION_KEY: z
    .string()
    .min(64, "APP_ENCRYPTION_KEY must be a 32-byte hex string (64 chars)")
    .max(64),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be >=32 chars"),
  DATA_DIR: z.string().default("./data"),
  SPROUT_URL: z.string().url().default("https://kmcsolutions.hrhub.ph/"),
  MAX_CONCURRENT_RUNS: z.coerce.number().int().min(1).max(20).default(3),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const config: AppConfig = loadConfig();
```

---

## Frontend `package.json` (target libraries — let the CLI pin exact versions)

> The frontend is the **latest** stack: **React 19, Tailwind CSS v4, shadcn-latest, Vite 6, TanStack Query v5**. These are all **post-cutoff** for a late-2024 local model, so **do not trust version numbers or setup from memory** — scaffold with the tools (Vite template + `pnpm dlx shadcn@latest init`) and **fetch current docs via Context7** (`reference/live-docs-and-mcp.md`) before writing. The set below is the target shape; the Vite template and shadcn CLI establish exact current versions.

```json
{
  "name": "sprout-automator-frontend",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "packageManager": "pnpm@11.0.0",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@tanstack/react-query": "^5",
    "class-variance-authority": "^0.7",
    "clsx": "^2",
    "lucide-react": "latest",
    "motion": "^12",
    "react": "^19",
    "react-dom": "^19",
    "tailwind-merge": "^3"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4",
    "@types/node": "^22",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "@vitejs/plugin-react": "^4",
    "tailwindcss": "^4",
    "tw-animate-css": "latest",
    "typescript": "^5.6",
    "vite": "^6"
  }
}
```

Notes (each is a thing a pre-2025 model gets wrong — verify via Context7 first):
- **Tailwind v4 is CSS-first:** no `postcss.config.js`, no `autoprefixer`, **no `tailwind.config.js`**. It's the `@tailwindcss/vite` plugin + `@import "tailwindcss"` + `@theme` in CSS. The animate plugin is **`tw-animate-css`** (v4's replacement for the v3-era `tailwindcss-animate`).
- **Radix UI deps are intentionally NOT listed** — `pnpm dlx shadcn@latest add <component>` installs the correct React-19-compatible Radix packages and writes them into `package.json`. Let the CLI own those.
- `motion` powers the run-log expand animation; `lucide-react` for icons.
- Installed with **pnpm** (`corepack enable pnpm`); a `pnpm-workspace.yaml` with supply-chain settings sits next to this file (see `reference/supply-chain-and-ci.md`).

## Frontend `vite.config.ts` (exact)

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()], // @tailwindcss/vite is Tailwind v4's setup (no postcss)
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    port: 5173,
    proxy: {
      "/auth": "http://localhost:3000",
      "/credentials": "http://localhost:3000",
      "/schedule": "http://localhost:3000",
      "/runs": "http://localhost:3000",
      "/health": "http://localhost:3000",
    },
  },
  build: { outDir: "dist" },
});
```

The proxy is what makes the dev loop work: the browser talks only to Vite (5173), which forwards API calls to the backend (3000), so the signed session cookie flows transparently same-origin.

---

## Scaffold commands

First, enable pnpm once (Node 22 ships Corepack): `corepack enable pnpm`.

### Backend (Phase 0)
```bash
mkdir -p app/backend/src
cd app/backend
# create package.json, tsconfig.json, pnpm-workspace.yaml (above + supply-chain ref), then:
pnpm install
# verify:
pnpm typecheck
```

### Frontend (Phase 3)
```bash
cd app
pnpm create vite frontend --template react-ts
cd frontend
# replace package.json deps with the exact set above, add pnpm-workspace.yaml, then:
pnpm install
# Tailwind + shadcn setup is detailed in phase-3.
```

### Local fast dev loop (no Docker rebuilds)
```bash
# 1. Postgres only, in Docker (map container 5432 → host 5433 in .env)
docker compose up -d postgres
# 2. Backend, native, hot-reload (~1s restart on save)
cd app/backend && pnpm dev
# 3. Frontend, native, Vite HMR (instant, preserves React state)
cd app/frontend && pnpm dev
# open http://localhost:5173  (NOT 3000)
```
Stop dev servers with **Ctrl+C** (not the terminal's X) — `tsx watch` spawns a child `node` that can survive and hold port 3000. If you hit `EADDRINUSE :3000` (PowerShell):
```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

### Full production-like build
```bash
docker compose up -d --build
docker compose exec backend pnpm db:migrate   # first time / when migrations change
curl http://localhost:3000/health              # {"status":"ok","db":"ok",...}
```
Rebuild the image only when deps, the Dockerfile, or you want to test the real bundled SPA.
