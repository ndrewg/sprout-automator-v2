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
