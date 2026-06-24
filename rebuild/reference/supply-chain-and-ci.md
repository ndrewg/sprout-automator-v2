# Reference — Supply-Chain Hardening & CI

Package-manager hardening (pnpm 11), secret scanning, and the minimal CI gate. Attach to **Phase 0** — this is set up before any dependency is installed. Verified against pnpm 11 (June 2026).

The threat this addresses is the **shai-hulud** class of npm supply-chain attacks: a compromised (often freshly-published) package runs a malicious `postinstall` script that steals secrets and self-propagates. "Use the latest version" does **not** help — a brand-new release is exactly the dangerous case. The defenses below attack the actual vectors: install-time scripts and just-published versions.

---

## 1. Use pnpm 11 (not npm)

pnpm 11 ships three relevant protections **on by default**:
- **`strictDepBuilds: true`** — a dependency's lifecycle build script is *refused* unless you explicitly allow it. This neutralizes the primary infection vector (malicious `postinstall`).
- **`minimumReleaseAge: 1440`** — refuses to install any version published less than 1440 minutes (1 day) ago, including transitive deps — so you dodge the window when a compromised release is live but not yet pulled.
- **`.npmrc` is registry/auth-only** — all behavioral settings live in `pnpm-workspace.yaml`.

### Install pnpm via Corepack (ships with Node 22+)
```bash
corepack enable pnpm
corepack prepare pnpm@latest --activate
pnpm --version   # expect 11.x
```
Pin the version in each `package.json`:
```json
"packageManager": "pnpm@11.0.0"
```

### `pnpm-workspace.yaml` — backend (`app/backend/pnpm-workspace.yaml`)
```yaml
# Supply-chain settings (pnpm 11). No `packages:` key — this is a single package,
# but pnpm still reads these settings from here.
minimumReleaseAge: 1440          # minutes; only install versions ≥1 day old.
                                  # Raise to 4320 (3 days) to be more conservative.
minimumReleaseAgeExclude: []     # add a package here only if you must hotfix faster

# strictDepBuilds is true by default: any dep build script not listed below FAILS
# the install. Allow ONLY the trusted native/build deps we actually need.
allowBuilds:
  esbuild: true                  # tsx's engine downloads its platform binary
  '@node-rs/argon2': true        # native napi binary
  playwright: true               # browser download hook (no-op on the PW base image)
```

### `pnpm-workspace.yaml` — frontend (`app/frontend/pnpm-workspace.yaml`)
```yaml
minimumReleaseAge: 1440
minimumReleaseAgeExclude: []
allowBuilds:
  esbuild: true                  # Vite's bundler
```

> If a future dep legitimately needs a build script, pnpm will error at install with the package name; add it to `allowBuilds` deliberately after you've checked it — never blanket-allow.

### Day-to-day commands (pnpm, not npm)
| Task | Command |
|------|---------|
| install | `pnpm install` |
| add a dep | `pnpm add <pkg>` (review the diff in `pnpm-lock.yaml`) |
| backend dev | `pnpm dev` |
| typecheck | `pnpm typecheck` |
| migrate | `pnpm db:migrate` |
| reproducible install (CI/Docker) | `pnpm install --frozen-lockfile` |
| audit | `pnpm audit` |

**Commit `pnpm-lock.yaml`.** Always `--frozen-lockfile` in CI and Docker (the pnpm equivalent of `npm ci`) so the build can't silently resolve a new/compromised version.

---

## 2. Dockerfile with pnpm (replaces the npm version in `04`)

```dockerfile
# Build context is ./app. Frontend build stage → ./public for the backend.
# Debian, not alpine: Tailwind v4's native engine has musl friction on alpine.
FROM node:22-bookworm-slim AS frontend
WORKDIR /fe
RUN corepack enable pnpm
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend ./
RUN pnpm build

# Runtime — Playwright base image (must match the pinned playwright npm version).
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

---

## 3. gitleaks pre-commit hook (block secret commits)

We already dodged one near-miss (a live `.env` + session cookies in the archive). gitleaks stops a secret from ever being committed.

`.pre-commit-config.yaml` at the repo root:
```yaml
repos:
  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.21.2
    hooks:
      - id: gitleaks
```
Install + activate:
```bash
pipx install pre-commit   # or: brew install pre-commit
pre-commit install
pre-commit run --all-files   # one-time scan of the whole tree
```
(If you don't want the `pre-commit` framework, install the `gitleaks` binary and add a `.git/hooks/pre-commit` that runs `gitleaks protect --staged --redact`.)

---

## 4. Minimal CI gate (the only thing type-checking your prod code)

Because the backend runs via `tsx` with **no compile step**, nothing type-checks before prod *unless you gate it*. This is also your net against the local model's type errors. A push-time gate is the highest-value guardrail in an LLM-driven build.

`.github/workflows/ci.yml` (or the equivalent for your forge):
```yaml
name: ci
on: [push, pull_request]
jobs:
  backend:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: app/backend } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: corepack enable pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test          # vitest (the pure-fn tests)
      - run: pnpm audit --audit-level=high
  frontend:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: app/frontend } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: corepack enable pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build         # tsc -b && vite build → catches type errors
```

If you're not on GitHub, replicate the same four backend steps as a **pre-push git hook** so a broken typecheck/test never reaches the remote.

---

## Checklist (do all of this in Phase 0, before installing deps)
- [ ] `corepack enable pnpm`; `packageManager` pinned in both `package.json`s
- [ ] `pnpm-workspace.yaml` in `app/backend` and `app/frontend` with `minimumReleaseAge` + `allowBuilds`
- [ ] `pnpm-lock.yaml` committed; `--frozen-lockfile` everywhere it installs
- [ ] gitleaks pre-commit installed and a clean `--all-files` scan
- [ ] CI (or pre-push hook): `typecheck` + `test` + `audit`
