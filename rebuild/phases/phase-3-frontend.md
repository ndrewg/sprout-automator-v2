# Phase 3 — Dashboard (React + Vite + shadcn + TanStack Query)

**Goal:** the SPA. Signup/login, then a dashboard with four panels: Schedule, Credentials (with the Gmail App Password walkthrough + Test connection), Run-now, and Run history (live status + OTP paste-in). Built so Express serves it from `./public` in production.

**Attach for this session:** `03-CONVENTIONS-AND-GUARDRAILS.md` (especially the ⭐ mutation rule), `04-STACK-SCAFFOLD-AND-CONFIG.md`, `reference/api-contract.md`, `reference/live-docs-and-mcp.md`.

> 📡 **Live docs first (this phase is the most cutoff-sensitive).** Before writing any frontend setup, fetch current docs via Context7 for: **React 19** (types: `useRef`, `JSX`, children), **Tailwind CSS v4** (`@tailwindcss/vite`, `@import "tailwindcss"`, `@theme`), **shadcn/ui** (latest CLI: `init` + `add`, Tailwind-v4 mode), **@tanstack/react-query v5**, **Vite**. A pre-2025 model will otherwise emit Tailwind v3 config and React 18 idioms. See `reference/live-docs-and-mcp.md`. **Do not write Tailwind/shadcn setup from memory — fetch it.**

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
3. **shadcn (latest CLI, Tailwind-v4 mode):** `pnpm dlx shadcn@latest init` → then `pnpm dlx shadcn@latest add button card input label badge alert checkbox`. The CLI writes `src/lib/utils.ts` (the `cn` helper), `src/components/ui/*` (with `data-slot` attributes, React-19/v4 correct), the theme CSS, and installs the correct React-19-compatible **Radix** deps into `package.json`. **Do not hand-paste components** — that's how v3/React-18 idioms sneak in.
4. **Extend two generated variants** (shadcn defaults are minimal): `alert` ships only `default`/`destructive` — add `success`/`warning`/`info`; `badge` — add `secondary`/`success`/`warning`/`info`/`destructive`. Edit the generated `cva` maps in those two files.

**Gate 3A:** `pnpm dev` serves a styled page at `http://localhost:5173`; Tailwind v4 classes apply; **no `tailwind.config.js` exists**; `pnpm build` (`tsc -b`) is clean under React 19 types; no console errors.

---

## 3B — Data layer (api + QueryClient + hooks)

1. `src/api.ts` — **verbatim from `reference/api-contract.md`** (the `request` helper, types, and `api` object).
2. `src/components/QueryClientProvider.tsx` — a `QueryClientWrapper` wrapping children in `QueryClientProvider`.
   > ⚑ RECOMMENDED #7: construct the client with defaults `{ queries: { staleTime: 30_000, retry: 1 } }`.
3. `src/main.tsx` — render `<React.StrictMode><QueryClientWrapper><App/></QueryClientWrapper></React.StrictMode>`, import `./index.css`.
4. Hooks in `src/hooks/` (one concern each):
   - `useMe` → `useQuery(["me"], api.me → user)` with **`retry: false`** (a 401 must not retry-storm).
   - `useLogin` / `useSignup` → `useMutation`; `onSuccess` writes the returned user into the `["me"]` cache (`qc.setQueryData`) so the gate flips without a refetch.
   - `useLogout` → `useMutation(api.logout)`; `onSuccess` → `qc.clear()`.
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
`useCredentials` + `useUpdateCredentials` + `useTestImap`. Two sections (Sprout / Gmail). Password fields show a `set` badge + `(unchanged)` placeholder when `*Set` is true, and only send a field if the user typed something (build a partial patch; if empty → "No changes."). `save()` and `test()` are async → `mutateAsync` in try/catch. `test()` renders success ("Connected — N message(s) in inbox.") or the humanized error in an Alert. Disable Test when there's no app password set and none typed.

**The Gmail App Password walkthrough** (collapsible "How do I set this up?" → an info Alert) — reproduce this content; it's the UX that keeps setup at ~5 minutes:
- *Step 1 — Enable 2-Step Verification.* Deep-link `https://myaccount.google.com/signinoptions/two-step-verification`. Ordered steps: sign in, pick 2-Step Verification, Get started, follow prompts, confirm the green check.
- *Step 2 — Generate an App Password.* Deep-link `https://myaccount.google.com/apppasswords` (only visible once 2-Step is on). Pick "Mail" + device, Generate, copy the 16-char password (`abcd efgh ijkl mnop`).
- *Step 3 — Paste and Test.* Paste (spaces are fine, stripped server-side), click **Test Gmail connection**, expect "Connected — N message(s)", then **Save credentials**.
- A warning Alert: Google shows the password **once** — copy it before leaving the page or regenerate.
- A destructive Alert for "Invalid credentials": used an App Password (not the normal password)? 2-Step on? pasted an old/invalidated one?

### ManualRunPanel
`useStartRun`. Two buttons ("Clock in now" / "Clock out now"), disabled while busy. `trigger(action)` async → `await startRun.mutateAsync(action)` in try/catch → "Run started." / error. (The runs query's adaptive polling then shows progress in RunsPanel.)

### RunsPanel
`useRuns` + `useSubmitOtp`. A table of recent runs (action, a `StatusBadge`, started, finished, detail). Rows expand to show the timestamped `steps` timeline (use `motion` for the expand animation). If any run has `waitingForOtp`, show a warning Alert with an OTP `Input` + "Submit OTP" button → `submitOtpHandler` async → `await submitOtp.mutateAsync({runId, code})` in try/catch. Import the `Run` type from `@/api` (do not redefine it locally).

**Gate 3D (full UX, in the browser):**
1. Save Sprout creds; set up a Gmail App Password via the walkthrough; **Test Gmail connection → success**.
2. Save a schedule; toggle enable; the holiday banner logic renders.
3. "Clock in now" → RunsPanel shows the run go pending→running→(success/skipped/failure) with the steps timeline filling in live (polling tightens to 1.5 s while active).
4. If a run waits for OTP and IMAP is slow, the paste-in box appears and a submitted code is accepted.

---

## 3E — Serve the SPA from Express (production wiring)

In `index.ts`, after the API routers: `express.static(path.resolve(__dirname,"../public"))` then a **catch-all GET** that serves `index.html` for any path **not** starting with `/auth|/credentials|/schedule|/runs|/health` (regex negative-lookahead) so client-side routing works while the API stays reachable. Use `fileURLToPath(import.meta.url)` for `__dirname` (ESM).

**Gate 3E:** `docker compose up -d --build` (full image), open `http://localhost:3000` (the backend, not Vite) → the SPA loads and the whole flow from 3D works against the bundled assets with prod security headers.

If 3A–3E pass, Phase 3 is done — five gate commits should already be in history (see Commit checkpoints above). Tag it: `git tag phase-3-complete`.
