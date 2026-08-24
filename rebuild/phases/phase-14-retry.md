# Phase 14 — Retry on transient failure

**Goal:** a clock-in that fails at 05:30 because the portal was down should try again on its own, instead of costing the whole day.

**Depends on phase 11.** Retry must consult the same holiday check, so phase 11 § 11A's widened return type must be merged first.

**Attach for this session:** `03-CONVENTIONS-AND-GUARDRAILS.md`, `02-DECISIONS-AND-ARCHITECTURE.md` (§ D8 the race guard, § D17 missed-run notices), `phases/phase-7-schedule-pause.md`, `reference/database-schema.md`, `reference/testing-strategy.md`.

> 📡 **Fetch live docs (Context7):** `node-cron` (one-shot scheduling, cancellation), Drizzle (partial index interaction on insert). Do not write these from memory.

---

## Why

A real clock-in failed in August 2026 because HRHub was unreachable. Nothing retried, and the standing position in `01-PROJECT-BRIEF.md` — "the next scheduled run is the de-facto retry" — is only true if *tomorrow* counts as a retry interval. For a clock-in it does not.

`navigateToPortal` already retries 3× on server errors, so this phase covers failures **past navigation**: login timeouts, an OTP that never arrives, the clock dialog not appearing, a portal that 500s after login.

**Honest limit, and it must be stated in the docs rather than discovered later:** this recovers from **HRHub** being down. It cannot recover from **this stack** being down — if Docker Desktop is not running, the thing that would schedule the retry is the thing that is missing. That case is phase 12's dead-man's-switch. The two features are complements, not alternatives, and neither substitutes for the other.

---

## 14A — The retry mechanism

**Contract — the hard constraint first:**

- **Retry `failure` only. Never `skipped`.** `BACKLOG.md` § 7 states this and it is load-bearing: `isAlreadyClockedForToday` fails safe by skipping on doubt, so retrying a skip turns one uncertain read into repeated clock attempts — precisely the double-clock that `runs_one_active_per_user` exists to prevent. A retry scheduled for a `skipped` run is a defect, not a tuning choice.

**Two independent brakes, both enforced:**
- **Interval** — configurable, default **30 minutes**.
- **Attempt cap** — configurable, default **3** retries.
- **A hard wall-clock cutoff per action** — clock-in retries stop mid-morning, clock-out retries stop at end of day. Enforced *independently* of the cap, so a mistuned interval cannot walk into the afternoon. **A clock-in recorded at 14:00 is a wrong record, not a late one** — the cutoff is what makes that impossible.

**Cancellation — a retry must stop for any reason the problem went away:**
- a successful run for the same action and Manila date,
- a **manual** run for that action (clicking "Clock in now" is an explicit statement of intent that supersedes the schedule),
- the next scheduled fire for that action,
- the day rolling over.

**Never retry into a day automation should not run:** re-check both the holiday layer (phase 11) and `isPausedOn` at each attempt, not only when the retry was scheduled. A pause set at 07:00 must cancel a retry queued at 05:30.

**Schema:** an `attempt` column on `runs`, new migration, **no edits to committed migrations**. The partial unique index is the subtle part — a retry must not collide with its own predecessor. Insert the retry only once the previous attempt has reached a terminal status, and let Postgres arbitrate (catch `23505` → treat as already-handled) rather than checking first. Never `SELECT WHERE running` then `INSERT` (D8).

**Config keys** — `RETRY_INTERVAL_MINUTES`, `RETRY_MAX_ATTEMPTS`, and the cutoffs. Each goes into `config.ts`, `.env.example` **and both compose files** in this gate. If any becomes a per-user setting instead, it needs a schedule column, a UI control and a migration — decide deliberately and say which in the report.

## 14B — Notification discipline

**This is where the feature most easily becomes worse than nothing.** Notifying on every retry trigger turns one bad morning into eight messages, and a channel people mute is a channel that cannot warn them about anything.

**Contract:**
- **One** message when the first failure schedules a retry, stating the next attempt time.
- **One** message on eventual success, or on final give-up ("tried 3 times, needs you").
- **Silence between attempts.** That is the design, not an omission.
- **Say the default exactly once**: the first time a retry is scheduled for a user who has never configured an interval, mention what it defaulted to. Not on every failure.
- **Suppress the missed-run alert while a retry is pending.** Without this the user gets "no run happened" and "retrying at 06:00" describing the same morning, which trains them to distrust both. `services/notifications.ts`'s sweep is where this interacts.
- Retry dispatch is **fire-and-forget and must never affect a run** — AGENTS.md rule 11, asserted by a test modelled on `notification-isolation.test.ts`.

**Also worth knowing:** every retry is a real HRHub login and a real OTP email. The attempt cap protects HRHub and the mailbox as much as it protects the record.

---

## Tests

**Integration:**
- A `failure` schedules exactly one retry; a `skipped` schedules **none**. This is the test that matters most — it must fail against an implementation that retries any non-success.
- The cap holds: after N retries the run is abandoned with one give-up notification.
- The cutoff holds **independently of the cap**: with a deliberately long interval, no attempt occurs past the cutoff even though attempts remain.
- A success, a manual run, and a pause set mid-morning each cancel a pending retry.
- A retry attempt on a holiday or paused day does not run.
- No duplicate missed-run alert while a retry is pending.
- A retry cannot collide with its predecessor under the partial unique index — two overlapping attempts produce one active run, not a `500`.

**Unit:** interval and cutoff arithmetic with an **injected clock**. No `Date.now()` inside the schedulable logic — `BACKLOG.md` § 11 is why.

**Gate 14:** `cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration`

---

## Verification Gate

```
cd app/backend  && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration
cd app/frontend && pnpm lint && pnpm test && pnpm build
docker compose config 2>&1 | grep -c "is not set"
```

Baselines: **161 backend unit / 106 backend integration / 5 frontend unit / 16 e2e.**

**`[manual]` — must not be claimed as passed:**

| # | Check | Pass looks like |
|---|---|---|
| 1 | Point `SPROUT_URL` at an unreachable host, let a scheduled run fire | Run marked `failure`; **one** Telegram naming the next attempt time |
| 2 | Restore `SPROUT_URL` before the next attempt | The retry succeeds; **one** success Telegram; no further attempts |
| 3 | Leave it unreachable for the whole window | Exactly N attempts, then **one** give-up message. No message per attempt |
| 4 | Fail a run, then click "Clock in now" manually and succeed | Pending retry cancels; no further attempts |
| 5 | Fail a run, then set a pause window covering today | The queued retry does not run |
| 6 | Force a `skipped` run (already clocked in) | **No retry scheduled at all** — the constraint that protects against double-clocking |
| 7 | Check the runs table after a retry sequence | `attempt` increments; one row per attempt; no orphaned `running` rows |

Row 6 is the one to be most suspicious of. Commit per the loop in `AGENTS.md`; tag `phase-14-complete` when the table is filled in.
