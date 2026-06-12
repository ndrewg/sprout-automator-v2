# 03 — Conventions & Guardrails

Feed this alongside every phase. It is short on purpose. The model should be able to hold all of it.

---

## Language & module rules (backend)

- **TypeScript only.** No `.js` files in `app/backend/`.
- **ESM** (`"type": "module"`).
- **`moduleResolution: "Bundler"`** + run with `tsx`. Therefore: **relative imports have NO extension.**
  ```ts
  import { db } from "../db/client";     // ✓ correct
  import { db } from "../db/client.js";  // ✗ WRONG — we are not on NodeNext
  ```
- **Type-only imports use the `type` keyword:**
  ```ts
  import { type Request, type Response } from "express";
  import type { Page } from "playwright";
  ```
- **Env vars via bracket access:** `process.env["NAME"]` (required by `noPropertyAccessFromIndexSignature`). But in app code, **read config through the validated `config` object**, not `process.env` directly.

## Style

- 2-space indent, double quotes, semicolons required.
- `camelCase` for variables/functions, `PascalCase` for types/classes.
- Prefer `type` aliases over `interface` (unless declaration merging is needed — e.g. augmenting Express's `Request`).
- Keep functions small and single-purpose; the module layout in `02` is the unit of organization.

## Async & modern idioms (2026 baseline) — READ THIS, it's the #1 local-LLM regression

**All sequential asynchronous logic uses `async`/`await` with `try/catch`. Never `.then().catch()` for control flow.** Local models love to fall back to promise chains — do not. If you are writing business logic (a DB query, an HTTP handler, a service call), it is `await` inside an `async` function, and errors are handled with `try/catch` (backend) or surfaced via the mutation's state (frontend).

```ts
// ✓ CORRECT — sequential logic, async/await + try/catch
async function loadUser(id: string) {
  try {
    const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!row) throw new Error("not found");
    return row;
  } catch (err) {
    log.error({ err }, "loadUser failed");
    throw err;
  }
}

// ✗ WRONG — promise chain for control flow. Do NOT write this.
function loadUser(id: string) {
  return db.select().from(users).where(eq(users.id, id)).limit(1)
    .then((rows) => rows[0])
    .catch((err) => { /* ... */ });
}
```

### The ONLY three places `.catch()` / `.then()` are allowed (and they are deliberate)

You will see `.catch()` in the reproduced automation and lib code. It is **not** the house style — it is three narrow, intentional idioms. Reproduce them verbatim where the reference shows them; **never extend them to your own logic.**

1. **Playwright best-effort probe** — an element may legitimately not exist, and a throw means "not present/visible". Idiom: `if (await locator.isVisible().catch(() => false)) { ... }` and `await locator.waitFor(...).then(() => true).catch(() => false)`.
2. **Fire-and-forget cleanup** that must never crash the caller: `await client.logout().catch(() => {})`, `await page.reload(...).catch(() => {})`, `await browser.close().catch(() => {})`.
3. **Top-level entrypoint** with no `async` frame above it: `main().catch((err) => { console.error(err); process.exit(1); })`.

Everything else is `await` + `try/catch`. If you're tempted to write `.then()` and you're not in one of those three cases, you're doing it wrong.

### Other modern defaults (don't regress these)
- `const` by default, `let` only when reassigned. **Never `var`.**
- Optional chaining `?.` and nullish coalescing `??` over `&&`/`||` truthiness hacks (`a ?? b`, not `a || b`, when `0`/`""` are valid values).
- `for...of` (or `Promise.all`/`Promise.any`) when awaiting in a loop — **never `await` inside `Array.prototype.forEach`** (it doesn't await).
- Node built-ins use the `node:` specifier: `import { randomBytes } from "node:crypto"`.
- Template literals over string concatenation; spread over `Object.assign`/`.concat`.
- No `any`. Strict mode is on (see below). Use `unknown` + narrowing for caught errors: `catch (err: unknown) { const msg = err instanceof Error ? err.message : String(err); }`.

## Strictness (do not relax to ship faster)

`strict` + `noUncheckedIndexedAccess` + `noImplicitOverride` + `noPropertyAccessFromIndexSignature` are all on. Consequences the model must handle, not disable:
- Index/array access yields `T | undefined`. Narrow it: `const x = arr[0]; if (!x) throw …` or `arr[0]!` only when provably safe with a comment.
- Destructured DB `.returning()` results are `T | undefined` — guard them (`if (!row) throw new Error("insert returned no row")`).

## Error handling (HTTP boundary)

- **Route handlers never throw across the HTTP boundary unhandled.** Validate with Zod (`safeParse`), respond with a JSON error on failure.
- The **global error handler** in `index.ts` is the backstop: log the error, respond `500 {"error":"Internal server error"}`, never leak a stack trace.
- Validation failures → `400` with `{ error, details: parsed.error.flatten() }`.
- Catch the Postgres unique-violation code **`23505`** specifically where it matters (signup → 409, run insert → already_running). Let other DB errors bubble to the 500 handler.

## The secrets rule (non-negotiable, applies everywhere)

Never let any of these reach a log line, an API response body, an error message, or audit metadata:
- Sprout password, Sprout username*, Gmail address*, Gmail App Password
- OTP codes
- Session ids / cookie values
- `APP_ENCRYPTION_KEY`, `SESSION_SECRET`, `DATABASE_URL`

(*usernames/emails are returned decrypted **only** in the authenticated `GET /credentials` for display — nowhere else, and never in logs.)

Concrete consequences:
- `GET /credentials` returns passwords as boolean `*Set` flags only.
- Audit metadata records *which fields changed*, never the values.
- Login-failure audit stores a non-reversible `emailHash`, not the email.
- Decrypted creds exist only as local variables inside the run executor for the duration of the run. Never attach them to `req`, never log them, never put them in a `runs.error` message.

## Tenant isolation rule (non-negotiable)

- **Every data query is scoped to `req.user.id`.** No route handler accepts a user id from the body, query, or params.
- File paths are derived from the authenticated `userId` (a UUID) via `lib/paths.ts` — never from user input.
- `requireAuth` guards every authenticated route; `attachUser` runs on every request to populate `req.user`.

## Database rules

- All feature queries go through Drizzle. The only raw SQL allowed is the `select 1` health check and migrations.
- Schema changes: edit `src/db/schema.ts` → `npm run db:generate -- --name <change>` → review generated SQL → `npm run db:migrate`. **Never edit a committed migration.**
- Insert-as-`pending` then rely on the partial unique index for run gating. **Never** `SELECT WHERE running` then `INSERT`.

## Module ownership rules (enforced "only place that imports X")

| Library | Only imported in | Everyone else calls |
|---------|------------------|---------------------|
| `playwright` | `src/automation/*` | `services/runs.ts` → automation |
| `imapflow` / `mailparser` | `src/lib/imap-otp.ts` | services import the helper fns |
| `date-holidays` | `src/lib/ph-holidays.ts` | import `isPhilippineHoliday` / `manilaDateString` |
| `@node-rs/argon2` | `src/lib/passwords.ts` | import `hashPassword`/`verifyPassword` |
| node `crypto` for creds | `src/lib/encryption.ts` | import `encrypt*`/`decrypt*` |
| `helmet`/`express-rate-limit` | `src/middleware/security.ts` | imported by `index.ts` |

## Frontend conventions

- **TanStack Query owns server state.** One hook per resource in `src/hooks/` (`useMe`, `useCredentials`, `useSchedule`, `useRuns`, `useLogin`, `useSignup`, `useLogout`, plus mutation hooks). Components consume hooks; they do not call `fetch` directly. All HTTP goes through the typed `api` object in `src/api.ts`.
- **`useState` is for ephemeral UI only** (form field values, which row is expanded, a transient status message). Never cache server data in `useState`.
- After a successful mutation, **invalidate the relevant query key** in `onSuccess` so the UI refetches.
- Polling: `useRuns` uses an **adaptive `refetchInterval`** — 1500 ms while any run is `pending`/`running`, 5000 ms otherwise. No manual `setInterval`.
- Path alias `@/` → `src/`. Mixed relative imports are fine (the alias is configured in `vite.config.ts`).

### ⭐ The mutation rule (this is the one that bit us — memorize it)

When a handler is `async` and uses `try/catch`, you **must** await `mutateAsync`:

```tsx
// ✓ CORRECT — promise-based, awaited, error lands in catch
const save = async () => {
  setSaving(true);
  setMsg(null);
  try {
    await updateSchedule.mutateAsync({ clockInTime, clockOutTime, enabled });
    setMsg("Saved.");
  } catch (e) {
    setMsg(e instanceof Error ? e.message : String(e));
  } finally {
    setSaving(false);
  }
};
```

```tsx
// ✗ WRONG — fire-and-forget; the catch never runs, errors vanish,
//           "Saved." shows even on failure
const save = async () => {
  try {
    updateSchedule.mutate({ clockInTime, clockOutTime, enabled }); // not awaited
    setMsg("Saved.");
  } catch (e) {
    setMsg("…"); // unreachable
  }
};
```

Rule of thumb: **`mutateAsync` + `await` whenever you're inside an `async` function with `try/catch`.** Use the callback form `mutate(args)` (no await) **only** in a plain non-async event handler where you don't need to react to success/failure inline (e.g. `onClick={() => logout.mutate()}`), and let the hook's own `onSuccess`/`onError` handle the result.

---

## The DO-NOT list (paste this into the model when it's about to go off-script)

1. **Do not add `.js` extensions** to relative imports. Resolution is Bundler.
2. **Do not switch to JWT.** Sessions are DB-backed; the cookie is an opaque signed UUID.
3. **Do not use bcrypt.** Argon2id only.
4. **Do not** read or write a `*_enc` column outside `lib/encryption.ts` callers.
5. **Do not** `SELECT WHERE running` then `INSERT` a run. Insert `pending`; catch `23505`.
6. **Do not** import `playwright` / `imapflow` / `date-holidays` outside their owning module.
7. **Do not** invent HRHub selectors. Reproduce `reference/hrhub-automation-playbook.md` verbatim.
8. **Do not** use `getByText` for the clock buttons — at narrow viewports the text exists but is `display:none`. CSS classes only, 1920×1080 viewport.
9. **Do not** widen the OTP regex. `(?<!\d)(\d{4,6})(?!\d)`, prefer 5-digit.
10. **Do not** log, echo, or store any secret (see the secrets rule).
11. **Do not** accept a user id from the request. Scope every query to `req.user.id`.
12. **Do not** call `mutate()` fire-and-forget when you need to await the result — use `mutateAsync`.
13. **Do not** add CSRF tokens (deferred — SameSite=Strict + same-origin covers it) unless you also add cross-origin OAuth.
14. **Do not** auto-create an enabled schedule on signup. Lazy opt-in only.
15. **Do not** edit a committed Drizzle migration. Generate a new one.
16. **Do not** raise `MAX_CONCURRENT_RUNS` without measuring memory (~300 MB per Chromium).
17. **Do not** abbreviate file output with "// rest unchanged" — emit complete files.
18. **Do not** use `.then()`/`.catch()` for sequential logic. Use `async`/`await` + `try/catch`. The only allowed `.catch()` cases are the three idioms in the "Async & modern idioms" section — reproduce verbatim, never generalize.
