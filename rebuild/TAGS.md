# TAGS — what is tagged, what isn't, and what each one still needs

Tags mark a phase as **provably complete, including its `[manual]` checks**. Executable gates are the agents' job; tags are yours, because only a human can confirm a Telegram message arrived, a browser rendered correctly, or a run reached live HRHub.

Last reviewed: **2026-08-14**.

## Tagged

`phase-0-complete` · `phase-1-complete` · `phase-2-complete` · `phase-3-complete` · `phase-4A2-complete` · `phase-6-complete` · `phase-7-complete` · `phase-T-complete`

## Untagged

| Phase | What it covers | Outstanding | Action |
|---|---|---|---|
| **4A** | Helmet CSP + HSTS, rate limits, trust proxy, body cap (`21a0971`) | One browser check | **Verify then tag** |
| **4B** | Mailer, password reset, idle timeout, email verification, account deletion | **Nothing** — all 18 `[manual]` checks passed across both rounds | **Tag now** |
| **L** | oxlint on both packages, CI + pre-commit, four fault probes | **Nothing** — probes proven to fail the build | **Tag now** |
| **5** | Prod compose, Caddy TLS, `DEPLOY.md`, `APP_URL` guard, backups | VPS host hardening + live-domain TLS — **both need a real host** | **Decide** — see below |
| **8** | Compose env passthrough, `AUTH_RATE_LIMIT`, real-client-IP keying | A real Cloudflare Tunnel in front | **Blocked** — closes with **phase 15** |
| **9** | `GET /runs` limit + `hasMore`, dates, Show more, Gmail copy | Onboarding one-pager (a document, not code) | **Tag now** |

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

### 4B — nothing outstanding, just tag it

Both rounds recorded all nine `[manual]` checks passing — mailer dev/prod logging, single-use tokens, the 11th-is-429 property, verification links, account deletion refusing while a run is active, the surviving `account_deleted` audit row. Nothing is waiting on you.

```powershell
git tag phase-4B-complete
```

### L — nothing outstanding, just tag it

All four fault probes were proven to fail the build, including the fragment-shorthand missing `key` that started the round. `pnpm lint` runs in CI and pre-commit with a zero-warning baseline.

```powershell
git tag phase-L-complete
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

### 9 — taggable now

Six of eight `[manual]` rows passed on 2026-08-14 (`reviews/phase-9-addendum.md` § F), including both that only a human could settle: "Show more" surviving the 1.5 s poll, and CI genuinely running the frontend suite.

Row 6 (OTP paste bridge) is **reached but not typed into** — the box rendered for four seconds before IMAP won the race, as designed. Row 7 (the onboarding one-pager) is a document nobody has written; it is tracked at `BACKLOG.md` § 5 part 2 and is not a property of the code.

```powershell
git tag phase-9-complete
```

---

## After tagging

```powershell
git push --tags
```

Tags are cheap and local until pushed. Nothing else in the build depends on them — they exist so that a future session can ask "what was actually finished?" and get an answer that isn't prose.

## The pattern worth keeping

Every tag above waited on a human, and that is not ceremony. Across this build, review caught the invisible defects — a privilege escalation, an unrate-limited endpoint, a spoofable rate-limit gate — while **a person clicking caught eleven others**, every one of them while all executable gates were green. The `[manual]` layer has found more than the other three combined. A phase whose `[manual]` table is unfilled is not finished, however green CI is.
