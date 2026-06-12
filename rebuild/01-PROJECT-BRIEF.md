# 01 — Project Brief

## The product

**Sprout Automator** is a self-hosted, multi-tenant web app. A small group of colleagues (≤ ~50, realistically a handful) each:

1. Sign up with email + password.
2. Store their **Sprout HRHub** login (username + password) and a **Gmail App Password** (for reading the login OTP email). All four secrets are encrypted at rest.
3. Set a daily schedule (e.g. clock in 05:30, clock out 18:05, Mon–Fri).
4. Have the system automatically log into Sprout HRHub on their behalf at those times, handle the OTP challenge, and click clock-in / clock-out — skipping weekends and Philippine public holidays, and skipping if they've already clocked for the day.

There is also a manual "Clock in / out now" button, a credentials page with a guided Gmail App Password walkthrough + "Test connection" button, and a run-history view with live status and an OTP paste-in fallback.

## Why it exists

Sprout HRHub requires a fresh email OTP on most logins, which makes a naive cron+script approach fragile. The original was a single-user n8n + Express + Playwright Docker stack. This v2 is a **proper multi-tenant rewrite**: no n8n, per-user encrypted credentials, a real web UI with auth, and an in-process scheduler. One VPS hosts it for the whole group.

## The core automation flow (what actually happens at 5:30 AM)

```
node-cron fires (Mon–Fri, Asia/Manila, per-user time)
  └─ holiday check (skip if PH public/bank holiday)
  └─ startRun(userId, action)
        ├─ INSERT runs row (status='pending')   ← DB unique index = "one active run per user"
        └─ enqueue runId on the in-memory queue (global Chromium concurrency cap)

queue drains a slot
  └─ executeQueuedRun(runId)
        ├─ UPDATE runs SET status='running'
        ├─ decrypt this user's Sprout + Gmail creds (in memory only)
        ├─ runAutomation:
        │     ├─ launch headless Chromium, load per-user saved session if any
        │     ├─ navigate to HRHub portal
        │     ├─ if not logged in → fill credentials → handle OTP
        │     │     └─ OTP source = race(IMAP poll  vs  manual paste); first wins
        │     ├─ reload page (refresh ASP.NET tokens after OTP)
        │     ├─ save session storage state for next time
        │     ├─ check "already clocked today?" → if yes, skip
        │     └─ perform the 4-step clock action against HRHub's dialogs
        └─ UPDATE runs SET status = success | skipped | failure, finishedAt=now
```

Every step appends a timestamped log line to the run row so the user can watch progress live in the UI.

## Non-negotiables (these are the spine of the project)

These appear again, in detail, in `02` and `03`. Listed here so the priorities are unmistakable:

1. **Custody of other people's credentials is the central responsibility.** Sprout passwords and Gmail App Passwords are encrypted with AES-256-GCM, key in env (never in DB). Secrets are never logged, never echoed in API responses, never stored in audit metadata. This is not a "phase 4 nicety" — it is baked in from phase 1.
2. **Tenant isolation.** Every query is scoped to the authenticated `userId`. No route ever accepts a user id from the request body. File paths are keyed by UUID.
3. **The DB is the source of truth for run state**, and a **partial unique index** is the only correct way to enforce "one active run per user" — not application-level checks.
4. **The HRHub automation is brittle and the selectors are load-bearing.** They are CSS-class-based (not text-based) and require a 1920×1080 viewport. They are documented verbatim in `reference/hrhub-automation-playbook.md` and must be reproduced exactly.
5. **Manila timezone and PH holidays are correctness concerns**, not cosmetics. All "what day is it" logic goes through one helper that computes the date in `Asia/Manila`.
6. **Fail safe, not fail loud, on the clock action.** If the system can't positively confirm you have NOT already clocked, it skips rather than risk a double-clock.

## Scope boundaries

**In scope for the rebuild:** everything in the phase files (scaffold → DB/auth/credentials → automation → frontend → security → deploy/ops).

**Explicitly deferred / optional** (called out where relevant, mostly Phase 4+):
- Email verification on signup & password reset (needs an email provider; recommended before inviting >3 people).
- TOTP 2FA.
- Retry-on-transient-failure (the next scheduled run is the de-facto retry).
- Multi-instance / clustered deploy (the in-memory queue and in-process cron are single-instance by design).
- Non-Gmail IMAP providers, non-Manila timezones.

## Success criterion

A colleague can: open the URL → sign up → save Sprout creds → set up a Gmail App Password via the in-app guide and see "Test connection" succeed → enable a schedule → click "Clock in now" and watch it reach real HRHub and succeed → and then have the scheduled run fire correctly the next weekday morning. On a ~$5/mo 2 GB VPS, behind TLS.
