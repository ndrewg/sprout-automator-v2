# Phase 10 — Admin role and visibility

**Goal:** make it possible to be an admin, then give that admin one read-only view answering "whose automation is failing".

**Depends on phases 8 and 9.** 8A must be merged or `ADMIN_EMAILS` will not reach the container. 9B must be merged because **this phase reuses the run-status table it establishes** — building the admin table first means writing it twice.

**Do not start this phase until a second person has an account.** With one user the overview is a table with one row and zero information. It is specced now so it is ready when it is needed; `BACKLOG.md` § 8 records the ranking.

**Attach for this session:** `03-CONVENTIONS-AND-GUARDRAILS.md`, `reference/api-contract.md`, `reference/database-schema.md`, `phases/phase-4-security.md` (§ 4A.2 for the allowlist parsing pattern this mirrors, § 4B.7 for the original sketch), `phases/phase-9-runs-history.md` (§ 9B, for the table conventions to reuse).

> 📡 **Fetch live docs (Context7):** Express 5 middleware ordering, Drizzle (joins, `distinct on` / lateral for last-row-per-group), TanStack Query v5. Do not write these from memory.

**Skills:** `shadcn` for components, `ui-ux-pro-max` (`Platform: Web`, skipping React-Native-only rules) for the responsive/a11y pass, `tailwind-design-system` for token consistency, `typescript-advanced-types` for the response types.

---

## 10A — A way to become an admin

**The defect is bigger than it looks.** `is_admin` exists in `db/schema.ts:24`, is returned by `publicUser` (`routes/auth.ts:75`), and is typed in `frontend/src/api.ts:19`. **Nothing sets it and nothing reads it.** There is no `requireAdmin`, no admin route, no seed, no grant path — so there is currently no way for anyone, including the operator, to become an admin. The column is inert and permanently `false`.

So the first half of this phase is the grant mechanism. There is nothing to gate on until it exists.

**Contract:**
- New config key **`ADMIN_EMAILS`** — comma-separated **exact addresses only**, matched case-insensitively against the already-lowercased email. Same parsing shape as `SIGNUP_ALLOWED` (`lib/signup-allowlist.ts`).
- **Reject any entry without an `@`** at config load, with a message naming the fix. `SIGNUP_ALLOWED` deliberately treats a bare token as a whole domain; here that would make **everyone at the company an admin**. The two keys look similar and will be confused, so the difference must be enforced rather than documented.
- **Config is authoritative, reconciled at boot.** On startup set `is_admin = true` for listed users and `false` for everyone else. This makes granting *and revoking* a config change, and means a wrong entry can never be silently persisted in the database. Log the **count** changed, never the addresses.
- An entry naming an address with no user account is **not an error** — log it at `warn` (as a count, not the address) and continue. Admins are often listed before they sign up.
- Optional in dev and in production; empty means no admins. An operator running this alone needs none.
- Add to `config.ts`, `.env.example` **and `docker-compose.yml`** — do not create another unreachable key (`BACKLOG.md` § 4 exists because that already happened).

**Contract — `requireAdmin`:**
- New middleware in `middleware/`, returning **404, not 403**, for a non-admin. A 403 confirms the endpoint exists; a normal user has no reason to learn an admin surface is there.
- Mounted **after** `requireAuth`, never instead of it — an unauthenticated request must still get 401.

**Tests (integration):**
- Boot reconciliation grants to a listed email and **revokes** from a previously-admin unlisted one.
- A config entry without `@` (`orchard.com.au`) **refuses to start**, with the fix named.
- An address in the list with no user account boots cleanly.
- Non-admin → 404. Unauthenticated → 401. Admin → 200.

**Gate 10A:** `cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration`

---

## 10B — `GET /admin/overview`

**Contract:**
- Admin-only, behind `requireAuth` then `requireAdmin`, rate-limited under the existing `apiLimiter`.
- Returns, for **every** user: `id`, `email`, `emailVerifiedAt`, `scheduleEnabled`, `clockInTime`, `clockOutTime`, `pausedFrom`, `pausedUntil`, `notificationsEnabled`, and the **last run per action** (`in` and `out`) as `{ status, finishedAt, error }`.
- **This is the only endpoint in the codebase that legitimately reads across tenants.** It is the sole exception to AGENTS.md rule 5. **Put a comment above the handler saying so** — otherwise a reviewer will correctly flag it as a violation, and that costs a round trip. Every other query stays scoped to `req.user.id`.
- **Never returns credential material**: no `*_enc` column, no `*Set` booleans, no Gmail address, no Telegram bot token, no chat id. `error` is the persisted run-error string, which is operator-facing by design and already redacted at write time.
- Read-only. **No impersonation, no credential access, no editing another user's schedule.** If that is ever wanted it is a separate phase with its own audit trail.
- Ordered **most-broken-first**: users whose latest run failed, then by email. An admin opens this to find problems, not to browse.
- Prefer one query with a lateral join / `distinct on` over N+1 per-user queries.

**Tests (integration):**
- The payload contains no `*_enc` value, no Gmail address and no bot token — asserted against a fixture user who has all three set.
- Ordering puts a user with a failed latest run above one with a success.
- A user with no runs at all appears, with nulls rather than being omitted.

**Gate 10B:** `cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration`

---

## 10C — The admin panel

**Contract:**
- A fifth panel, rendered **only when `me.isAdmin`**. It must not appear, flicker, or reserve space for a non-admin.
- Table: email, schedule, last in, last out — status via the **existing** status badge component. **Reuse phase 9B's table conventions**: `tabular-nums` on all date/time cells, `Today`/`Yesterday` relative dates, `overflow-x-auto` wrapper. Consistency between the two tables is the point; do not invent a second style.
- `useAdminOverview` via TanStack Query like every other panel. No `useState` for server data (AGENTS.md rule 12). **No polling** — an admin refreshes deliberately; a background poll on a cross-tenant endpoint is needless load.
- Empty and error states: a useful message, not a blank table (ui-ux-pro-max § 8 `empty-states`).
- Responsive: table scrolls inside its container at 375 px; the page never scrolls sideways.

**Gate 10C:** `cd app/frontend && pnpm lint && pnpm build && pnpm exec playwright install chromium && pnpm test:e2e`

---

## Verification Gate (the whole phase)

```
cd app/backend  && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration
cd app/frontend && pnpm lint && pnpm build && pnpm test:e2e
docker compose config | grep ADMIN_EMAILS
```

**`[manual]` — must not be claimed as passed:**

| # | Check | Pass looks like |
|---|---|---|
| 1 | Add your address to `ADMIN_EMAILS`, restart, reload the dashboard | The admin panel appears |
| 2 | Log in as a second, non-listed account | No panel; `curl` to `/admin/overview` returns **404** |
| 3 | Remove your address, restart | The panel is gone — revocation works from config alone |
| 4 | Set `ADMIN_EMAILS=orchard.com.au` (no `@`) and restart | The app **refuses to boot**, naming the fix |
| 5 | Admin panel at 375 px | Table scrolls inside its container; the page does not scroll sideways |
| 6 | Compare the admin table to the runs table | Same date format, same badges, same alignment — they read as one product |

Commit per the loop in `AGENTS.md`. Tag `phase-10-complete` when the `[manual]` rows are filled in.
