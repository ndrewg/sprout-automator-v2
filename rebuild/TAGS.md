# TAGS — what is tagged, what isn't, and what each one still needs

Tags mark a phase as **provably complete, including its `[manual]` checks**. Executable gates are the agents' job; tags are yours, because only a human can confirm a Telegram message arrived, a browser rendered correctly, or a run reached live HRHub.

Last reviewed: **2026-09-03**.

> **4B, L and 9 were tagged 2026-09-03**, closing the three that had nothing outstanding. Phases 10–14 have since shipped their code and joined the queue below. **Eleven phases now sit untagged**, which is the state this file exists to prevent: with nothing tagged, "what was actually finished?" has no answer but prose.

## Tagged

`phase-0-complete` · `phase-1-complete` · `phase-2-complete` · `phase-3-complete` · `phase-4A2-complete` · **`phase-4B-complete`** · `phase-6-complete` · `phase-7-complete` · **`phase-9-complete`** · **`phase-L-complete`** · `phase-T-complete`

**Applied 2026-09-03: 4B, L and 9.** Each is an annotated tag pointing at the commit where that phase’s code landed (`c453c62`, `4323518`, `114b42f`) — **not** at whatever HEAD was on tagging day, so `git checkout phase-9-complete` gives the right tree. Each message records what was verified and what was deliberately skipped. **Not pushed yet** — `git push --tags`.

## Untagged

| Phase | What it covers | Outstanding | Action |
|---|---|---|---|
| **4A** | Helmet CSP + HSTS, rate limits, trust proxy, body cap (`21a0971`) | One browser check | **Verify then tag** |
| **5** | Prod compose, Caddy TLS, `DEPLOY.md`, `APP_URL` guard, backups | VPS host hardening + live-domain TLS — **both need a real host** | **Decide** — see below |
| **8** | Compose env passthrough, `AUTH_RATE_LIMIT`, real-client-IP keying | A real Cloudflare Tunnel in front | **Blocked** — closes with **phase 16** |
| **10** | vitest 4, drizzle-orm 0.45, `pnpm audit --prod` gate | 5 rows — incl. the **from-empty schema diff**, which phase 15 makes row 1 | **Blocked** — see below |
| **11** | `optional` holidays skip; typed holiday return; skip notice | 3 rows — the real one needs **2026-11-02** | **Wait for the day** |
| **12** | Truthful `/health`, Windows backup, heartbeat, log rotation | 8 rows — needs a **reboot** and a **real restore** | **Verify then tag** |
| **13** | `EXTRA_HOLIDAYS` + Official Gazette advisory layer | 5 rows — incl. a real proclamation day and the **next Eid** | **Wait for the day** |
| **14** | Retry on transient failure — cap + independent cutoff | 7 rows — needs a **live HRHub outage window** | **Verify then tag** |

---

## What each still needs

### 4A — one browser check, five minutes

The as-built note in `phases/phase-4-security.md` § 4A requires verifying the CSP against **the built SPA at `:3000`**, not the Vite dev server at `:5173` — HMR uses inline/eval scripts a strict CSP blocks, so dev mode proves nothing here.

```powershell
docker compose up -d --build backend
```

Open `http://localhost:3000`, open DevTools → Console, and click through all panels. **Pass = zero CSP violation messages.** Then:

```powershell
git tag phase-4A-complete
```

### 5 — needs a decision, not a check

Two `[manual]` items remain and **both require a real server**: VPS host hardening (`phase-5-deploy-ops.md` § 5.2 — non-root user, SSH hardening, `fail2ban`, UFW) and a live-domain certificate.

**This may never happen.** The current direction (`BACKLOG.md` § 12) is a Cloudflare Tunnel on the laptop, where **Cloudflare terminates TLS and Caddy is not used at all** — so the live-domain-cert check has no meaning in that topology, and there is no VPS to harden.

So choose:

- **Tag it now as locally-verified** — everything provable without a host *was* proven: `tls internal` end to end, the backend port unpublished, the `APP_URL` production guard, and a real `pg_dump` → `pg_restore` cycle. Add a tag message saying the two host-dependent checks were never run.
- **Leave it untagged** until a VPS exists, accepting it may stay untagged forever.

Recommendation: **tag it**, with an honest message. An untagged phase that nobody can ever complete is worse than a tag that states its own limits.

```powershell
git tag -a phase-5-complete -m "Locally verified: tls internal, backend port unpublished, APP_URL guard, pg_dump/pg_restore. NOT verified: VPS host hardening (5.2) and a live-domain certificate - both need a real host, and the current direction (BACKLOG 12) is a Cloudflare Tunnel where Caddy is not used."
```

### 8 — blocked on the domain

The one outstanding check is `reviews/phase-8-addendum.md` § D: put a **real Cloudflare Tunnel** in front and confirm that arming `TRUSTED_CLOUDFLARE_PEERS` makes real per-client IPs reach the rate limiter — literal and CIDR forms, the startup count log, and the once-only mismatch warning.

Everything else in phase 8 is verified live: `AUTH_RATE_LIMIT=15` → 16th request 429, unset → 31st, 40 forged `CF-Connecting-IP` headers sharing one bucket with the gate off.

**Do not tag until the tunnel exists.** This is the one check that proves § 8C does what it was built for; without it, that gate is only proven to be safely *off*.

---

### 10 — blocked behind phase 15, deliberately

Five `[manual]` rows, and **row 1 gates the rest**: restore a backup into a scratch DB, `pnpm db:migrate` **from empty**, and diff tables/indexes/constraints against live `sprout`. That is the only check that catches a migration runner silently skipping older migrations after the nine-minor Drizzle upgrade — and **three migrations (`0005`, `0006`, `0007`) now sit unapplied on top of that unverified base.**

`phases/phase-15-post-run-remediation.md` promotes it to *its* row 1 for exactly this reason. **Do not apply those migrations to a database holding real encrypted credentials until it passes.** Tag 10 after phase 15's manual table is filled in, not before.

### 11 — the real check is a date

`2026-08-21` (Ninoy Aquino Day) misfired *before* the fix existed, so the honest verification is the next weekday `optional` holiday: **2026-11-02, All Souls' Day**, then 2026-12-08, 12-24 and 12-31.

The other two rows are checkable now: a `public` holiday must skip **silently** (no Telegram), and a container restart on a holiday must not send a duplicate notice. Forcing the date with `EXTRA_HOLIDAYS` proves the plumbing but **not** the library classification — if you force it, record in the addendum that you did, because a forced pass is weaker evidence.

### 12 — the two rows that need patience

Six of eight are quick: stop Postgres and confirm `/health` returns **503** with `status: "degraded"` (a down DB used to report `200 ok` — that was the lie the phase fixed); start it and confirm `scheduler.registered` matches the enabled schedules; point `HEARTBEAT_URL` at a real endpoint, then at a black hole and confirm a run is unaffected.

Two need real time: **register `backup.ps1` in Task Scheduler, reboot Windows without logging in, and confirm the task still ran** — that is the whole point of "run whether or not the user is logged on" — and **restore that dump into a scratch DB**. A dump nobody has restored is not a backup.

### 13 — mostly waiting on the calendar

`EXTRA_HOLIDAYS=<tomorrow>` and `EXTRA_HOLIDAYS=2026-02-31=Nope` (must refuse to boot) are checkable today. The two that matter are not: a **real proclamation day** skipping and being named in the notification, and the **next Eid** skipping on the *proclaimed* date rather than the library's computed one — the case no bundled dataset can get right.

Also worth doing early: block outbound access to the Gazette and confirm a run completes anyway. Phase 15 § 15A exists because a missing gazette **table** currently throws instead of degrading; verify the *network* path separately from that fix.

### 14 — needs an outage you can create

Point `SPROUT_URL` at an unreachable host, let a scheduled run fire, and confirm **one** Telegram naming the next attempt time — not one per attempt. Then restore it before the next attempt and confirm one success message. Leave it unreachable for the whole window and confirm exactly N attempts then **one** give-up.

**Row 6 is the one to be most suspicious of:** force a `skipped` run (already clocked in) and confirm **no retry is scheduled at all**. That constraint is what stops a fail-safe verification skip turning into repeated clock attempts — the double-clock the partial unique index exists to prevent.

Note the standing limitation while you test: pending retries live in memory, so a container restart drops them. Phase 15 § 15C fixes that; until then, don't restart mid-window and conclude the feature is broken.

---

## After tagging

```powershell
git push --tags
```

Tags are cheap and local until pushed. Nothing else in the build depends on them — they exist so that a future session can ask "what was actually finished?" and get an answer that isn't prose.

## The pattern worth keeping

Every tag above waited on a human, and that is not ceremony. Across this build, review caught the invisible defects — a privilege escalation, an unrate-limited endpoint, a spoofable rate-limit gate — while **a person clicking caught eleven others**, every one of them while all executable gates were green. The `[manual]` layer has found more than the other three combined. A phase whose `[manual]` table is unfilled is not finished, however green CI is.
