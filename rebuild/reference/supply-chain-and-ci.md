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
      - run: pnpm audit --audit-level=high --prod   # blocking, prod-only
      - run: pnpm audit --audit-level=high          # full tree, non-blocking
        continue-on-error: true
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

### What the audit gate means (decision, 2026-08-24, phase 10)

`pnpm audit` consults a **live** advisory database. A repository that compiled and tested clean yesterday fails today because someone published an advisory — no commit caused it. In August 2026 the backend job went red on 18 advisories with zero dependency changes, and nobody noticed because nobody had pushed. That is the trap: a permanently-red pipeline is one people stop reading.

The deliberate decision (implemented in phase 10, recorded here so the next person to see a red pipeline knows the choice was made on purpose):

- **`pnpm audit --audit-level=high --prod` is BLOCKING.** A high/critical advisory in a dependency the production image installs (`pnpm install --frozen-lockfile --prod`) reaches users — it fails the build, and someone must respond. This is the honest signal the gate exists for.
- **The full-tree audit (`pnpm audit --audit-level=high`, devDependencies included) runs NON-BLOCKING** (`continue-on-error: true`) so tooling advisories stay visible on every run without red-ing the pipeline. Of the 18 findings that broke CI in 2026-08, 13 arrived through `vitest` — a devDependency the production image omits, including the lone "critical" (Vitest UI arbitrary file read, which additionally requires running Vitest UI, which this project never does). A gate that fails on tooling nobody deploys is mostly noise.
- **Advisory-only (`continue-on-error` on the prod audit too) was rejected** — an advisory check is one nobody reads, which is exactly how the pipeline rotted in the first place.

Phase 10 also cleared every advisory that a bump could clear: vitest 2.1 → 4.1 (the 13 devDep findings), drizzle-orm 0.36 → 0.45.2 + drizzle-kit 0.28 → 0.31 (the SQL-identifier injection HIGH), date-holidays 3.30 → 3.35, mailparser 3.9.11 → 3.9.15, imapflow 1.4 → 1.7, node-cron 3 → 4 (drops the vulnerable uuid), and two **scoped `overrides`** in `app/backend/pnpm-workspace.yaml` for transitives with no upstream fix (`esbuild@~0.18.20` → 0.28.1 through the deprecated `@esbuild-kit` chain that `drizzle-kit`'s config loader still uses; `html-to-text@10.0.0` → 10.0.1, whose `deepmerge-ts ^7.1.5` was the last prod finding). Both audits report **No known vulnerabilities found** today.

---

## Checklist (do all of this in Phase 0, before installing deps)
- [ ] `corepack enable pnpm`; `packageManager` pinned in both `package.json`s
- [ ] `pnpm-workspace.yaml` in `app/backend` and `app/frontend` with `minimumReleaseAge` + `allowBuilds`
- [ ] `pnpm-lock.yaml` committed; `--frozen-lockfile` everywhere it installs
- [ ] gitleaks pre-commit installed and a clean `--all-files` scan
- [ ] CI (or pre-push hook): `typecheck` + `test` + `audit`
