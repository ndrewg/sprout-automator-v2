# Phase 3 — Dashboard (React + Vite + shadcn + TanStack Query)

**Goal:** the SPA. Signup/login, then a dashboard with four panels: Schedule, Credentials (with the Gmail App Password walkthrough + Test connection), Run-now, and Run history (live status + OTP paste-in). Built so Express serves it from `./public` in production. **It must be fully responsive — colleagues will use it on phones as well as desktop.**

**Attach for this session:** `03-CONVENTIONS-AND-GUARDRAILS.md` (especially the ⭐ mutation rule), `04-STACK-SCAFFOLD-AND-CONFIG.md`, `reference/api-contract.md`, `reference/live-docs-and-mcp.md`.

> 📡 **Live docs first (this phase is the most cutoff-sensitive).** Before writing any frontend setup, fetch current docs via Context7 for: **React 19** (types: `useRef`, `JSX`, children), **Tailwind CSS v4** (`@tailwindcss/vite`, `@import "tailwindcss"`, `@theme`), **shadcn/ui** (latest CLI: `init` + `add`, Tailwind-v4 mode), **@tanstack/react-query v5**, **Vite**. A pre-2025 model will otherwise emit Tailwind v3 config and React 18 idioms. See `reference/live-docs-and-mcp.md`. **Do not write Tailwind/shadcn setup from memory — fetch it.**

> 🎨 **UI/UX — use the `ui-ux-pro-max` skill (design intelligence).** It's a Python-CLI skill; invoke it (or run `python <skill-dir>/scripts/search.py …`, where `<skill-dir>` is `~/.agents/skills/ui-ux-pro-max`). Two uses, both before/during the panels:
> 1. **Design system (do once, first):** `… "SaaS dashboard internal attendance tool data-dense professional" --design-system --persist -p "Sprout Automator"` → writes `design-system/MASTER.md` (palette, fonts, style, spacing scale). Read it before writing UI; map its tokens into the Tailwind v4 `@theme` block.
> 2. **Responsive review (our users are on phones):** `… "responsive breakpoint mobile tablet table form" --domain ux`. **Use only the `Platform: Web` rows:** mobile-first (Tailwind `md:/lg:/xl:`), test 320/375/414/768/1024/1440, `min-h-dvh` not `100vh`, wide tables → `overflow-x-auto` or card layout on mobile, reserve space to avoid CLS.
> - **Skip** the skill's `--stack react-native` mode and its native-app-only rules (44pt touch, safe-area insets, haptics, VoiceOver) — we're a responsive web SPA. **Do keep** its universal a11y rules (contrast ≥4.5:1, visible focus rings, keyboard nav, real form labels).

> 🧩 **shadcn — use the `shadcn` skill (the component authority; v4-aware).** It injects live project context (`pnpm dlx shadcn@latest info --json`: `aliases`, `tailwindVersion`, `base`, `iconLibrary`, `framework`) and is more reliable than memory for shadcn specifics. For ALL shadcn work (init/add/search/docs/compose/fix), follow it. Pre-answered for our build so the model doesn't stall on its interactive guards:
> - **Runner:** `pnpm dlx shadcn@latest …` (our `packageManager` is pnpm). **Registry is `@shadcn`** — don't ask, that's our default. **Don't switch presets mid-build.** A named preset (`nova`/`vega`/`maia`/`lyra`/`mira`/`luma`) at init is optional for a nicer default theme.
> - **Before using any component:** `pnpm dlx shadcn@latest docs <component>` and fetch the URLs — don't guess the API.
> - **Follow the skill's Critical Rules — they OVERRIDE the older panel sketches below where they differ:** forms use **`FieldGroup` + `Field`** (not raw `div`+`Label`); validation = `data-invalid` on `Field` + `aria-invalid` on the control; `gap-*` not `space-y-*`; `size-*` not `w-/h-`; **semantic tokens** (`bg-primary`, `text-muted-foreground`) never raw colors; button icons use `data-icon` (no size classes); Dialog/Sheet need a Title; prefer `Alert`/`Badge`/`Empty`/`Skeleton`/`Separator`/`sonner` over custom markup.

> **Three UI tools, three lanes — don't conflate:** **`shadcn` skill** = shadcn CLI + composition/styling (injects project context; wins on shadcn specifics). **`ui-ux-pro-max` skill** = design decisions + responsive/UX/a11y review. **Context7** = current docs for everything else (React 19, Tailwind 4 core, TanStack Query, Vite, Express, Drizzle).

Build in four sub-steps. **The mutation rule (D11 / §03) is the thing that broke last time — keep it in front of the model the whole phase.**

> **Commit checkpoints** — commit only on a green gate; never a red one; *you* run the commit, not the agent. Suggested messages:
> - Gate 3A → `chore(phase-3): vite + tailwind + shadcn scaffold [gate 3A]`
> - Gate 3B → `feat(phase-3): api client + tanstack query hooks [gate 3B]`
> - Gate 3C → `feat(phase-3): auth shell (AuthGate/AuthPage/Dashboard) [gate 3C]`
> - Gate 3D → `feat(phase-3): schedule/credentials/run/runs panels [gate 3D]`
> - Gate 3E → `feat(phase-3): serve SPA from express in prod [gate 3E]`
> Then tag: `git tag phase-3-complete`.

---

## 3A — Scaffold the frontend (latest stack: React 19 + Tailwind 4 + shadcn-latest)

Lean on the CLIs — they emit React-19/Tailwind-v4-correct code so the model doesn't have to. **Fetch the current steps via Context7** (shadcn "install with Vite" + Tailwind v4 install) and follow *those*; the sequence below is the shape to expect:

1. `cd app && pnpm create vite frontend --template react-ts`; add `pnpm-workspace.yaml` (supply-chain settings from `reference/supply-chain-and-ci.md`); `pnpm install`.
2. **Tailwind v4 (NOT v3):** `pnpm add tailwindcss @tailwindcss/vite tw-animate-css`. Add the `@tailwindcss/vite` plugin to `vite.config.ts` (verbatim from `04` — alias + dev proxy + tailwind plugin all required). **No `tailwind.config.js`, no `postcss.config.js`, no `autoprefixer`.** In `src/index.css`: `@import "tailwindcss";` + `@import "tw-animate-css";` + the shadcn `@theme inline {…}` token block + `:root`/`.dark` design tokens (the shadcn init writes this — see step 3).
3. **shadcn (use the `shadcn` skill, Tailwind-v4 mode):** `pnpm dlx shadcn@latest init` → then `add` the components we use: `button card input badge alert checkbox field` (forms use the `Field`/`FieldGroup` primitives — run `shadcn docs field` first) plus any others the panels need (`select`, `table` markup is hand-rolled but `skeleton`/`empty`/`separator`/`sonner` are handy). The CLI writes `src/lib/utils.ts` (`cn`), `src/components/ui/*` (`data-slot`, React-19/v4 correct), the theme CSS, and the correct React-19 **Radix** deps. **Do not hand-paste components** — let the CLI emit them. Follow the skill's Critical Rules for composition.
4. **Add our status variants** (shadcn defaults are minimal): the run UI needs `success`/`warning`/`info` on `Badge` and `Alert` (default ships only `default`/`destructive`). Extend the generated `cva` variant maps **properly** (new variants using semantic tokens) — do **not** override colors via `className` (the skill forbids that).

**Gate 3A:** `pnpm dev` serves a styled page at `http://localhost:5173`; Tailwind v4 classes apply; **no `tailwind.config.js` exists**; `pnpm build` (`tsc -b`) is clean under React 19 types; no console errors.

> ⚠️ **Build-time corrections (found 2026-06):** the current Vite `react-ts` template is **Vite 8 + TS 6** (newer than doc 04's Vite 6 target) — let the CLI pin it. **TS 6 deprecates `baseUrl`**, so the shadcn `@/*` alias uses `paths` *without* `baseUrl` in `tsconfig.json` + `tsconfig.app.json` (paths resolve relative to the tsconfig). shadcn `init` flags: there is **no `--base-color`**; use `-b radix -p <preset> --pointer -y` (e.g. `-p nova`). The Badge/Alert `success`/`warning`/`info` status variants (step 4) are only consumed by the RunsPanel — fine to add in **3D** with that panel rather than here.

---

## 3B — Data layer (api + QueryClient + hooks)

1. `src/api.ts` — **verbatim from `reference/api-contract.md`** (the `request` helper, types, and `api` object).
2. `src/components/QueryClientProvider.tsx` — a `QueryClientWrapper` wrapping children in `QueryClientProvider`.
   > ⚑ RECOMMENDED #7: construct the client with defaults `{ queries: { staleTime: 30_000, retry: 1 } }`.
3. `src/main.tsx` — render `<React.StrictMode><QueryClientWrapper><App/></QueryClientWrapper></React.StrictMode>`, import `./index.css`.
4. Hooks in `src/hooks/` (one concern each):
   - `useMe` → `useQuery(["me"], api.me → user)` with **`retry: false`** (a 401 must not retry-storm).
   - `useLogin` / `useSignup` → `useMutation`; `onSuccess` writes the returned user into the `["me"]` cache (`qc.setQueryData`) so the gate flips without a refetch.
   - `useLogout` → `useMutation(api.logout)`; `onSuccess` → **`qc.resetQueries()`** (see the as-built note below — **not** `qc.clear()`).
   > ⚠️ **As-built (found 2026-08, phase T):** this line originally specified `qc.clear()`, and that was a **real bug**. `clear()` empties the cache but does not notify subscribers, so the `["me"]` observer in `AuthGate` kept its stale user and the Dashboard never unmounted after logout. `resetQueries()` notifies observers and refetches, so `/auth/me` 401s and `AuthGate` flips back to the login page. Caught by the phase-T e2e smoke flow on its first run — the fix is in `app/frontend/src/hooks/useAuth.ts`.
   - `useCredentials` → `useQuery(["credentials"])`; `useUpdateCredentials` → mutation, `onSuccess` invalidates `["credentials"]`; `useTestImap` → mutation (`api.testImap`), no invalidation.
   - `useSchedule` → `useQuery(["schedule"])`; `useUpdateSchedule` → mutation, invalidates `["schedule"]`.
   - `useRuns` → `useQuery(["runs"])` with **adaptive `refetchInterval`**: 1500 ms if any run is `pending`/`running`, else 5000 ms; `useStartRun` + `useSubmitOtp` → mutations invalidating `["runs"]`.
   > ⚑ RECOMMENDED #5: type the `refetchInterval` callback with TanStack's `Query` type instead of `any`.

**Gate 3B:** `pnpm typecheck`/build clean. (Behavior is exercised in 3C/3D.)

---

## 3C — Auth shell

- `src/App.tsx` → renders `<AuthGate />` only (3 lines).
- `src/components/AuthGate.tsx` → `useMe()`; while `isLoading` show a centered "Loading…"; then `user ? <Dashboard/> : <AuthPage/>`.
- `src/components/pages/AuthPage.tsx` → a single card with email + password (min 12), a login/signup mode toggle, error alert from the mutation's `error`. Submit handler uses the **callback form** here intentionally: `active.mutate({email,password})` and surfaces `active.error`/`active.isPending` reactively (this is the allowed non-async-handler case — see §03). On success the `["me"]` cache write flips `AuthGate` to the dashboard.
- `src/components/pages/Dashboard.tsx` → header (app name, `user.email`, a Log out `Button` using `onClick={() => logout.mutate()}`) + `<main>` rendering the four panels in order: `SchedulePanel`, `CredentialsPanel`, `ManualRunPanel`, `RunsPanel`.

**Gate 3C:** sign up in the browser → lands on the dashboard; reload → still logged in (cookie); Log out → back to AuthPage; bad login → inline error.

---

## 3D — The four panels

All panels follow the same pattern: a query hook for reads, local `useState` only for form inputs + a transient status message, and **`await mutation.mutateAsync(...)` inside an async `try/catch`** for writes (the ⭐ rule).

### SchedulePanel
`useSchedule` + `useUpdateSchedule`. Inputs: two `type="time"` fields (seed from `data.clockInTime.slice(0,5)` etc.) and an "Run automatically Mon–Fri" checkbox. Header shows `data.today.date` and, if `data.today.holiday`, an amber "PH holiday: … Auto-runs are skipped today." `save()` is async → `await updateSchedule.mutateAsync({clockInTime, clockOutTime, enabled})` in try/catch, set "Saved." / error message.

### CredentialsPanel
`useCredentials` + `useUpdateCredentials` + `useTestImap`. Two sections (Sprout / Gmail).

> **As-built refinement (user-preferred):** render Sprout and Gmail as **two separate `Card`s, each with its own Save button** (each builds a partial patch for only its fields, so saving one leaves the other's stored secrets untouched) — clearer than one shared Save far below both. Password / app-password inputs use a **reveal (show/hide) toggle** via shadcn `InputGroup` + `InputGroupAddon`/`InputGroupButton` (eye icon) — the correct primitive per the shadcn skill (buttons-in-inputs = InputGroup), not a hand-rolled button. Add the `input-group` component in 3A's `add` list. Password fields show a `set` badge + `(unchanged)` placeholder when `*Set` is true, and only send a field if the user typed something (build a partial patch; if empty → "No changes."). `save()` and `test()` are async → `mutateAsync` in try/catch. `test()` renders success ("Connected — N message(s) in inbox.") or the humanized error in an Alert. Disable Test when there's no app password set and none typed.

**The Gmail App Password walkthrough** (collapsible "How do I set this up?" → an info Alert) — reproduce this content; it's the UX that keeps setup at ~5 minutes:
- *Step 1 — Enable 2-Step Verification.* Deep-link `https://myaccount.google.com/signinoptions/two-step-verification`. Ordered steps: sign in, pick 2-Step Verification, Get started, follow prompts, confirm the green check.
- *Step 2 — Generate an App Password.* Deep-link `https://myaccount.google.com/apppasswords` (only visible once 2-Step is on). Pick "Mail" + device, Generate, copy the 16-char password (`abcd efgh ijkl mnop`).
- *Step 3 — Paste and Test.* Paste (spaces are fine, stripped server-side), click **Test Gmail connection**, expect "Connected — N message(s)", then **Save credentials**.
- A warning Alert: Google shows the password **once** — copy it before leaving the page or regenerate.
- A destructive Alert for "Invalid credentials": used an App Password (not the normal password)? 2-Step on? pasted an old/invalidated one?

### ManualRunPanel
`useStartRun`. Two buttons ("Clock in now" / "Clock out now"), disabled while busy. `trigger(action)` async → `await startRun.mutateAsync(action)` in try/catch → "Run started." / error. (The runs query's adaptive polling then shows progress in RunsPanel.)

### RunsPanel
`useRuns` + `useSubmitOtp`. A table of recent runs (action, a `StatusBadge`, started, finished, detail). Rows expand to show the timestamped `steps` timeline (use `motion` for the expand animation). If any run has `waitingForOtp`, show a warning Alert with an OTP `Input` + "Submit OTP" button → `submitOtpHandler` async → `await submitOtp.mutateAsync({runId, code})` in try/catch. Import the `Run` type from `@/api` (do not redefine it locally). **Responsive:** wrap the table in `overflow-x-auto` so it scrolls (not breaks) on phones — per the skill's `Platform: Web` table-handling rule.

> **Responsive is a requirement, not a polish item** (colleagues use this on phones). Every panel: mobile-first, single-column stacking on small screens (the dashboard `max-w-*` container + grid collapses to one column), tap targets comfortable, `min-h-dvh` over `100vh`. Apply the skill's `Platform: Web` responsive rules from the 🎨 callout above.

**Gate 3D (full UX, in the browser):**
1. Save Sprout creds; set up a Gmail App Password via the walkthrough; **Test Gmail connection → success**.
2. Save a schedule; toggle enable; the holiday banner logic renders.
3. "Clock in now" → RunsPanel shows the run go pending→running→(success/skipped/failure) with the steps timeline filling in live (polling tightens to 1.5 s while active).
4. If a run waits for OTP and IMAP is slow, the paste-in box appears and a submitted code is accepted.
5. **Responsive check:** at **375px** (phone) and **768px** (tablet) — no horizontal scroll on the page, panels stack to one column, the runs table scrolls inside its own container, all controls tappable, nothing clipped. Then desktop (1440px). Run the skill's `--domain ux` responsive review as a final pass.

---

## 3E — Serve the SPA from Express (production wiring)

In `index.ts`, after the API routers: `express.static(path.resolve(__dirname,"../public"))` then a **catch-all GET** that serves `index.html` for any path **not** starting with `/auth|/credentials|/schedule|/runs|/health` (regex negative-lookahead) so client-side routing works while the API stays reachable. Use `fileURLToPath(import.meta.url)` for `__dirname` (ESM).

> ⚠️ **Prerequisites the 3E gate needs (create them now — found missing 2026-06):** the build fails without them.
> - **`app/backend/Dockerfile`** — reproduce verbatim from doc `04` / `reference/supply-chain-and-ci.md` (pnpm, Playwright base). It's referenced by `docker-compose.yml` but no earlier phase materialized it.
> - **`app/.dockerignore`** (build context is `./app`) excluding `**/node_modules`, `**/dist`, `**/.env*`, `backend/data` — **not in the original spec.** Without it, `COPY frontend ./` / `COPY backend …` drag host (Windows) `node_modules` into the Linux image and the build breaks.

**Gate 3E:** `docker compose up -d --build` (full image), open `http://localhost:3000` (the backend, not Vite) → the SPA loads and the whole flow from 3D works against the bundled assets with prod security headers.

If 3A–3E pass, Phase 3 is done — five gate commits should already be in history (see Commit checkpoints above). Tag it: `git tag phase-3-complete`.
