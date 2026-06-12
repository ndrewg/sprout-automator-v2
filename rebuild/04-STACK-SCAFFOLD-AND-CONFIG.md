# 04 — Stack, Scaffold & Config

Exact dependency versions and the full contents of every config file. The LLM should reproduce these **verbatim** — versions are pinned where a bump could change behavior (Playwright especially).

---

## Repo layout (target)

```
sprout-automator/
├── docker-compose.yml
├── docker-compose.prod.yml        # Caddy overlay (Phase 5)
├── Caddyfile                      # (Phase 5)
├── .env.example                   # committed; real .env is gitignored
├── .gitignore                     # must exclude .env, node_modules, data/, dist/, public/
├── DEPLOY.md
└── app/
    ├── backend/
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── drizzle.config.ts
    │   ├── Dockerfile
    │   ├── drizzle/               # generated migrations (committed)
    │   └── src/                   # see module layout in 02
    └── frontend/
        ├── package.json
        ├── tsconfig.json
        ├── vite.config.ts
        ├── tailwind.config.js
        ├── postcss.config.js
        ├── components.json        # shadcn config
        ├── index.html
        └── src/
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
  "scripts": {
    "dev": "tsx watch --env-file=../../.env src/index.ts",
    "start": "tsx src/index.ts",
    "typecheck": "tsc --noEmit",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "tsx src/db/migrate.ts",
    "db:studio": "drizzle-kit studio"
  },
  "dependencies": {
    "@node-rs/argon2": "^2.0.0",
    "cookie-parser": "^1.4.7",
    "date-holidays": "^3.23.12",
    "drizzle-orm": "^0.36.0",
    "express": "^4.21.0",
    "express-rate-limit": "^7.4.1",
    "helmet": "^8.0.0",
    "imapflow": "^1.3.3",
    "mailparser": "^3.7.2",
    "node-cron": "^3.0.3",
    "pg": "^8.13.0",
    "playwright": "1.49.1",
    "tsx": "^4.19.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/cookie-parser": "^1.4.7",
    "@types/express": "^4.17.21",
    "@types/mailparser": "^3.4.5",
    "@types/node": "^20.14.0",
    "@types/node-cron": "^3.0.11",
    "@types/pg": "^8.11.0",
    "drizzle-kit": "^0.28.0",
    "typescript": "^5.6.0"
  }
}
```

Notes:
- **`playwright` is pinned exactly to `1.49.1`** (no caret). It must match the Playwright Docker base image tag `v1.49.1-noble`. If you bump one, bump both.
- Express is intentionally **v4** (`^4.21`), not v5. The `@types/express` is `^4.17`.
- ⚑ **RECOMMENDED additions:** `pino` + `pino-http` (structured logging), and dev deps `vitest` (tests). See `02` improvements 1 & 2. Add `"test": "vitest"` to scripts if you adopt them.

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

## Backend `Dockerfile` (exact)

```dockerfile
# Build context is ./app (one level up), so paths are frontend/* and backend/*.

# Frontend build stage — produces ./public for the backend to serve.
FROM node:20-alpine AS frontend
WORKDIR /fe
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend ./
RUN npm run build

# Runtime stage — Playwright base image. We run TypeScript directly with tsx;
# no separate compile step.
FROM mcr.microsoft.com/playwright:v1.49.1-noble
WORKDIR /app
ENV NODE_ENV=production
COPY backend/package.json backend/package-lock.json* ./
RUN npm install --omit=dev
COPY backend/tsconfig.json ./
COPY backend/src ./src
COPY backend/drizzle ./drizzle
COPY backend/drizzle.config.ts ./
COPY --from=frontend /fe/dist ./public

RUN mkdir -p /app/data && chown -R pwuser:pwuser /app/data /app/public
USER pwuser

EXPOSE 3000
CMD ["npx", "tsx", "src/index.ts"]
```

---

## `docker-compose.yml` (exact, dev/base)

```yaml
services:
  postgres:
    image: postgres:16-alpine
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

## Frontend `package.json` (exact)

```json
{
  "name": "sprout-automator-frontend",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@radix-ui/react-checkbox": "^1.3.3",
    "@radix-ui/react-label": "^2.1.8",
    "@radix-ui/react-slot": "^1.2.4",
    "@tanstack/react-query": "^5.100.14",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "lucide-react": "^1.16.0",
    "motion": "^12.40.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "tailwind-merge": "^3.6.0",
    "tailwindcss-animate": "^1.0.7"
  },
  "devDependencies": {
    "@types/node": "^25.9.1",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.49",
    "tailwindcss": "^3.4.15",
    "typescript": "^5.6.0",
    "vite": "^5.4.11"
  }
}
```

Notes:
- **React 18** (`^18.3`), Vite 5, **Tailwind 3** (`^3.4` — not v4). shadcn/ui components are vendored into `src/components/ui/` (see Phase 3), which is why there's no `shadcn` runtime dep — only its Radix/cva/clsx/tailwind-merge building blocks.
- `motion` (Framer Motion's successor package) powers the run-log expand animation. `lucide-react` for icons.

## Frontend `vite.config.ts` (exact)

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
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

### Backend (Phase 0)
```bash
mkdir -p app/backend/src
cd app/backend
# create package.json, tsconfig.json (above), then:
npm install
# verify:
npm run typecheck
```

### Frontend (Phase 3)
```bash
cd app
npm create vite@latest frontend -- --template react-ts
cd frontend
# replace package.json deps with the exact set above, then:
npm install
# Tailwind + shadcn setup is detailed in phase-3.
```

### Local fast dev loop (no Docker rebuilds)
```bash
# 1. Postgres only, in Docker (map container 5432 → host 5433 in .env)
docker compose up -d postgres
# 2. Backend, native, hot-reload (~1s restart on save)
cd app/backend && npm run dev
# 3. Frontend, native, Vite HMR (instant, preserves React state)
cd app/frontend && npm run dev
# open http://localhost:5173  (NOT 3000)
```
Stop dev servers with **Ctrl+C** (not the terminal's X) — `tsx watch` spawns a child `node` that can survive and hold port 3000. If you hit `EADDRINUSE :3000` (PowerShell):
```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

### Full production-like build
```bash
docker compose up -d --build
docker compose exec backend npm run db:migrate   # first time / when migrations change
curl http://localhost:3000/health                 # {"status":"ok","db":"ok",...}
```
Rebuild the image only when deps, the Dockerfile, or you want to test the real bundled SPA.
