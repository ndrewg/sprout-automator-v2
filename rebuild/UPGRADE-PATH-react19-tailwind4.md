# Upgrade Path — React 19 + Tailwind 4 (do this when your model can handle it)

The baseline build targets **React 18 + Tailwind 3** deliberately: as of this writing the local model in use (Qwen3.6-35B-A3B-MTP) has a **late-2024 training cutoff**, so it has no internalized patterns for Tailwind v4's CSS-first config or React 19's type changes and would fight you on them. React 18.3 / Tailwind 3 are still maintained and are not a security liability, so there is no urgency.

**Do this upgrade when, and only when:** you switch to a coding model whose **training cutoff is ≥ mid-2025** (verify the *cutoff* on the model card, not the release date — they differ). At that point the model knows the new idioms and the migration is low-risk.

Release dates, for matching against a model's cutoff:
- React 19.0 stable — **December 5, 2024**
- Tailwind CSS v4.0 stable — **January 22, 2025**
- shadcn/ui full React 19 + Tailwind v4 support — early 2025 (the CLI now defaults new projects to both)

---

## What does NOT change (this is most of the frontend)

The entire data/logic layer is framework-version-agnostic and stays exactly as built in Phase 3:
- `src/api.ts`, all TanStack Query hooks (`useMe`, `useCredentials`, `useSchedule`, `useRuns`, …) — TanStack Query v5 runs on React 19 unchanged.
- The API contract, the four panels' logic, the ⭐ `mutateAsync` mutation rule, `AuthGate`/`AuthPage`/`Dashboard`.
- The Express backend, DB, automation — entirely unaffected (this is a frontend-only upgrade).

So the upgrade touches **dependencies + the Tailwind setup + component vendoring** — not your application code.

---

## Migration steps

### 1. Dependencies (`app/frontend/package.json`)
- `react` / `react-dom` → `^19`, `@types/react` / `@types/react-dom` → `^19`.
- Tailwind v4: replace `tailwindcss@^3` with `tailwindcss@^4` and **add `@tailwindcss/vite`**. **Remove** `postcss`, `autoprefixer`, `postcss.config.js`, and `tailwind.config.js` — v4 doesn't use them.
- Bump Radix packages to their current (React-19-compatible) versions. Re-pin via `pnpm add`.

### 2. Tailwind v4 is CSS-first (the big change)
- Wire the Vite plugin in `vite.config.ts`:
  ```ts
  import tailwindcss from "@tailwindcss/vite";
  export default defineConfig({ plugins: [react(), tailwindcss()], /* …alias, proxy… */ });
  ```
- `src/index.css` replaces the v3 `@tailwind base/components/utilities` + JS config with:
  ```css
  @import "tailwindcss";
  @theme inline { /* design tokens (colors, radius) as CSS variables */ }
  :root { /* shadcn HSL/oklch vars */ }
  .dark { /* … */ }
  @layer base { /* base resets */ }
  ```
- There is **no `tailwind.config.js`**. Theme tokens live in CSS via `@theme`. Let the shadcn CLI generate the correct `index.css` for you (next step).

### 3. Re-vendor shadcn components with the current CLI
Don't hand-port the v3 components. Run the current CLI so it emits React-19 + Tailwind-v4 correct sources (they gain `data-slot` attributes and v4 styling):
```bash
pnpm dlx shadcn@latest init      # choose Tailwind v4
pnpm dlx shadcn@latest add button card input label badge alert checkbox
```
This regenerates `src/components/ui/*` and the theme CSS in the v4 shape.

### 4. Fix React 19 type changes
`@types/react@19` is stricter. Expect to touch:
- `useRef()` now requires an initial argument → `useRef<T>(null)`.
- No implicit `children` on `React.FC` — type `children` explicitly (the spec's `{ children }: { children: React.ReactNode }` is already correct).
- The global `JSX` namespace moved to `React.JSX` (rarely hit in app code).
Run `pnpm build` (`tsc -b`) and fix what it flags — it's usually a handful of lines.

### 5. Dockerfile: frontend build stage → Debian, not Alpine ⚠️
Tailwind v4's engine (Oxide / lightningcss) ships **native binaries that have musl/Alpine friction**. Change the frontend build stage base image:
```dockerfile
FROM node:22-bookworm-slim AS frontend   # was node:22-alpine — v4 native bins are happier on glibc
```
(The runtime stage is the Playwright Debian-based image already, so only the build stage matters.)

### 6. CSP — no change needed
The existing `style-src 'self' 'unsafe-inline'` already covers Tailwind v4's injected styles. Leave the Helmet CSP as-is.

---

## Verification after upgrade
- `pnpm build` clean (this is where React 19 type errors surface).
- `docker compose up -d --build` → the SPA renders identically; the four panels, auth flow, and run-log animation all work.
- Visual spot-check: shadcn components look right (the `data-slot`-based styling resolves).

## Rollback
It's a frontend-only, dependency-level change isolated to `app/frontend`. If it misbehaves, `git revert` the upgrade commit(s); the backend and all app logic are untouched.
