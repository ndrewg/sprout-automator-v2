# Phase 12 — Durability & Observability — Test Addendum

**Tester session:** 2026-08-24 · fresh session, no coder context.

---

## A. Gate re-run results

### Backend
```
$ cd app/backend && pnpm lint
$ oxlint
```
(passes — zero warnings)

```
$ cd app/backend && pnpm typecheck
$ tsc --noEmit
```
(passes — zero errors)

```
$ cd app/backend && pnpm test
176 passed (176)
Duration: 1.18s
```
**Count matches the report (176 unit).**

```
$ cd app/backend && pnpm test:integration
118 passed (118)
Duration: 29.86s
```
**Count matches the report (118 integration).**

### Frontend
```
$ cd app/frontend && pnpm lint
$ oxlint
```
(passes)

```
$ cd app/frontend && pnpm test
5 passed (5)
```
**Count matches (5 frontend unit).**

```
$ cd app/frontend && pnpm build
✓ built in 189ms
```
(passes)

### Docker Compose
```
$ docker compose config 2>&1 | findstr /C:"variable"
(no output — zero warnings)
```
**Confirmed: zero "is not set" warnings.**

```
$ docker compose -f docker-compose.yml -f docker-compose.prod.yml config > /dev/null
EXIT_OK
```
**Prod overlay merges cleanly.**

### CI
```
$ python -c "import yaml;yaml.safe_load(open('.github/workflows/ci.yml'))"
YAML_OK
```

### PowerShell syntax
```
$ pwsh -NoProfile -Command "$null = [ScriptBlock]::Create((Get-Content -Raw ./scripts/backup.ps1))"
BACKUP_OK
```

---

## B. Findings

### B1 — `.gitignore` change unreported (non-blocking)

The diff includes a `.gitignore` modification adding `logs_86137047854/` to the ignore list. The Handoff report does not list `.gitignore` in its "What I changed" section. This is a housekeeping addition (pre-existing untracked log directory from 2026-08-14) that should have been noted. It is not harmful — the directory is properly gitignored and was never committed — but it is an unreported change in the working tree.

**Fix:** Add `.gitignore` to the "What I changed" section, or remove the change if it was not intended for this phase.

### B2 — DEPLOY.md §4 does not list `HEARTBEAT_URL` (non-blocking)

The DEPLOY.md production environment section (§4) documents all config keys but does not mention `HEARTBEAT_URL` in the "Optional but worth setting" list or the `.env` example block. The `.env.example` file does document it correctly. This is a minor documentation gap — an operator following DEPLOY.md §4 would not know about the heartbeat feature.

**Fix:** Add `HEARTBEAT_URL` to the §4 optional list with a brief description.

### B3 — Health leak test checks only specific test values (non-blocking)

The integration test `test/integration/health.test.ts` line 106-114 ("response body leaks no email and no secret") creates a user with `email: "leakcheck@example.com"` and `password: "supersecret-password-1234"`, then asserts the JSON body does not contain these strings or the pattern `@example.com`. The test is structurally sound — the health response only contains aggregate counts and timestamps, so no user-specific data can appear. However, the test does not check for generic patterns (e.g., any email regex, any `sid`, any `APP_ENCRYPTION_KEY` substring) which would catch a broader class of leakage. Given the response structure, this is a theoretical concern only — the fields are `status`, `service`, `version`, `db`, `scheduler.*`, `queue.*`, `timestamp`, none of which can contain secrets. Verdict: **adequate, not blocking.**

### B4 — rotate-key.ts not built: verdict (non-blocking by design)

The spec (§12C) explicitly offers the off-ramp: "write the manual procedure and stop" if the script cannot be done in a contained way. The DEPLOY.md §9 rotation procedure is thorough and accurate:
- App stopped, one transaction, backup first ✓
- References the correct encryption module (`lib/encryption.ts`) ✓
- Never logs a key/plaintext/ciphertext ✓
- Notes the absence of a committed script and explains why ✓
- Lists the five `*_enc` columns correctly ✓

The "doc-only" choice is defensible. A re-keying script would need to parameterize the `KEY` derivation in `lib/encryption.ts` (currently a module-level const from ambient env), adding surface area to the most security-sensitive code. The manual procedure with a scratch-restore test is safer for a one-operator deployment. **No finding; the decision is correct.**

### B5 — Backup script uses `cmd /c` without explicit `-i` (non-blocking, clarification)

`scripts/backup.ps1` line 63: `cmd /c "docker exec $CONTAINER pg_dump ... > $TMP"`. The comment on line 62 says "docker exec -i (NOT -T)" but the actual command does not include `-i`. This is correct: the `-i` flag keeps stdin open, and backup pipes only stdout to a file via `cmd /c` redirection — there is no stdin pipe. The restore script (`scripts/restore.ps1` line 55) correctly uses `docker exec -i` because `pg_restore` reads binary data from stdin. No finding; both scripts are correct.

---

## C. What I could not verify

These checks genuinely require a human, a live deployment, or external infrastructure. I cannot close them.

| # | Check | Why I can't verify |
|---|---|---|
| 1 | Stop Postgres → `/health` returns 503, `db: "down"` | I can only test the integration test suite's pool.end() approach (which passed). Stopping the actual Docker container and hitting a live endpoint requires manual verification. |
| 2 | Start everything → `/health` returns 200 with correct `scheduler.registered` | Requires a live boot where `loadAllSchedules()` actually runs and a real user has an enabled schedule. |
| 3 | Register `backup.ps1` in Task Scheduler → `.gz` dump appears | Requires Windows Task Scheduler execution. |
| 4 | Restore dump into scratch database → tables/row counts match | Requires running the actual backup → restore pipeline against a real Postgres container. |
| 5 | Reboot Windows, don't log in → backup still runs | Requires a physical reboot and "run whether or not user is logged on" verification. |
| 6 | Set `HEARTBEAT_URL` to a real endpoint → external service records the ping | Requires a live endpoint (UptimeRobot, Better Uptime, etc.) and a real scheduler fire. |
| 7 | Point `HEARTBEAT_URL` at a black hole → run completes normally | Requires a real clock action against the live app. The integration test proves the property in the test harness; live verification is for the operator. |
| 8 | `docker compose logs backend --tail 5` after a day → logs present, file bounded | Requires the stack to have been running for a day with real traffic. |

---

## D. Verdict

**Clean to commit.** All gates pass with correct counts (176 unit / 118 integration / 5 frontend unit). No blocking findings. The three non-blocking findings are:

1. **B1** (`.gitignore` unreported) — add to the report or remove the change
2. **B2** (`HEARTBEAT_URL` missing from DEPLOY.md §4) — minor doc gap
3. **B3** (health leak test scope) — adequate as-is, structural correctness is sufficient

The 8 `[manual]` checks from the phase file remain outstanding and must be verified by the human operator. The phase is ready for review; the `[manual]` table must remain open for tagging.
