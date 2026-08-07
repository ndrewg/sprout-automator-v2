# Reference — Testing Strategy (executable gates)

Attach to **every** phase from Phase 6 onward. This file exists because the build's verification model changed.

---

## Why this replaces "run this curl and look at it"

Phases 0–5 were written for a human orchestrating a weak local model one phase per session. Their Verification Gates are shell commands whose output a **person** interprets: fire five `POST /runs` in parallel and count the 202s; check that a response "isn't instant"; look at a psql dump and confirm it's opaque.

That works when a human is the loop. It does not work when an agentic model is the loop, because:

- **A model cannot honestly self-verify against a prose gate.** Asked whether the gate passed, it will reason about whether the code *ought* to pass and report success. Not dishonesty — it has no other signal.
- **Agentic loops make many small edits.** The regression risk isn't one bad generation, it's the fortieth edit quietly breaking something verified thirty edits ago. Only an automated suite catches that.
- **The most important properties in this system are invisible.** Tenant isolation, the `23505` race guard, "no secret in this response" — none of them show up as a broken screen. They fail silently and correctly-looking.

So: **a gate is a command with an exit code.** `pnpm typecheck && pnpm test` either passes or it doesn't, and no model can talk its way past it.

---

## The layers

| Layer | Runs | Needs | What it's for |
|---|---|---|---|
| **Unit** (`vitest`) | always, ~instant | nothing | pure logic: crypto, OTP extraction, cron expressions, holidays, pause windows, message rendering |
| **Integration** (`vitest` + real Postgres) | always | a test database | anything where the *database* is the mechanism: the race guard, cascades, partial-update semantics, tenant isolation |
| **E2E** (`playwright`) | on demand / CI | built SPA + backend | the flows a user actually performs: signup → credentials → schedule → run |
| **Live HRHub** | manual, never in CI | real credentials | the only way to validate selectors. Not automatable — see below. |

### The layer that cannot exist

**HRHub automation itself is not testable.** The selectors are load-bearing against a third-party site we don't control and can't stage. `clock.ts` can be exercised against a fixture page, but that only proves the code matches the fixture — the fixture is a snapshot of *our belief* about HRHub, and drift is exactly when that belief is wrong.

Drift detection stays what it always was: **screenshots**. Every run writes them to `data/screenshots/<userId>/<runId>/`. When a run fails at the clock step, hand those images to a vision-capable model along with `reference/hrhub-automation-playbook.md` and ask what changed. That is a deliberate human-triggered step, not a gate.

This is the residual risk of the whole project and it is irreducible. Everything else should be automated so that when something breaks, HRHub drift is the *only* remaining suspect.

---

## The high-value tests (ranked)

Ordered by "an agentic model will regress this and nothing will notice."

**1. The single-active-run race guard.** The system's most important correctness property, currently verified by hand-counting curl responses. Insert two `pending` runs for one user concurrently → exactly one survives, the other raises `23505` and maps to `already_running`. Then finish the first and prove a third insert succeeds. This is an integration test — the mechanism *is* the partial unique index, so a mocked database proves nothing.

**2. Tenant isolation.** Currently verified by nobody. For every authenticated route: user A, holding a valid session, must not be able to read or mutate user B's runs, credentials, schedule, or notification settings. Table-drive it over the route list so a new route added without isolation fails the suite.

**3. Secrets never leave.** Assert on response *shape*, not values: `GET /credentials` has no key matching `/password/i` whose value is a string; `GET /notifications` never contains the bot token; `publicUser` has no `passwordHash`. Cheap, and it catches the whole class.

**4. Credential partial-update semantics.** Three-way (omit / string / `null`) across four fields. Easy to get subtly wrong, invisible when wrong — you find out when a save wipes a password. Assert each field independently: omitting one must not disturb another.

**5. Lazy opt-in.** A `PUT /schedule` that omits `enabled` on a **fresh insert** must not enable it. The DB default is `true`, so the correct behaviour depends on the route explicitly overriding it. Phase 2 flags this trap; nothing currently enforces it. Same test for `notification_settings` (whose default is `false` — assert that too, so a future migration can't flip it).

**6. Orphan recovery.** Insert a `running` row, run `recoverOrphanedRuns()`, assert it becomes `failure` with the restart message and that the user can start a new run. This is what unblocks a user after a crash.

**7. Notification isolation from run outcome** (Phase 6). With the Telegram transport pointed at a dead endpoint, a run still reaches its terminal status on time. The guarantee is "notifications never affect runs" and it is exactly the kind of thing a refactor breaks.

**8. Pure functions** — already partly covered: `encrypt`/`decrypt` round-trip and tamper rejection, `extractOtpCode`, `timeToCronExpression`, `manilaDateString` / `isPhilippineHoliday`, and (Phase 7) `isPausedOn` boundaries.

---

## Mechanics

**Layout** — `test/` mirroring `src/` (already established): `test/lib/`, `test/services/`, `test/routes/`. `tsconfig.json` includes `test/**/*` so `tsc --noEmit` type-checks them.

**Integration tests need a real database.** Point `DATABASE_URL` at a scratch database, run migrations, truncate between tests. The existing `vitest.config.ts` supplies dummy env so `config.ts`'s import-time Zod validation passes; integration runs override `DATABASE_URL`. Keep unit and integration in separate vitest projects so the fast suite stays fast and runnable with no database at all.

**Never hit real Gmail, real Telegram, or real HRHub in a test.** Inject the transport. `lib/telegram.ts` is deliberately DB-free and `services/notifications.ts` is deliberately HTTP-free precisely so each can be tested without the other.

**Module ownership carve-out.** `03-CONVENTIONS-AND-GUARDRAILS.md` says `playwright` is imported only in `src/automation/*`. E2E tests need it too. The rule means **`src/`**; `test/` is exempt. Stated here so the rule and the tests don't contradict each other.

---

## What a phase gate looks like now

Every new phase states its gate as commands plus the assertions they encode:

```bash
pnpm typecheck          # no errors
pnpm test               # unit + integration, all green
pnpm test:e2e           # only for phases touching the SPA
```

Prose gates are still allowed for things genuinely requiring a human — "a message arrives in Telegram", "the panel doesn't overflow at 375px", "the run reached real HRHub". Mark those **`[manual]`** so it is unambiguous which checks the loop can close by itself and which need you.
