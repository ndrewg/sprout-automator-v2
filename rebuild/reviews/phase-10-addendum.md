# Phase 10 — Dependency Hygiene — Tester Addendum

## A. Gate re-run results

All gates run from a fresh session. Postgres confirmed running before start.

### Backend
```
$ cd app/backend && pnpm lint
$ oxlint
(exit 0 — clean)

$ cd app/backend && pnpm typecheck
$ tsc --noEmit
(exit 0 — clean)

$ cd app/backend && pnpm test
$ vitest run --project unit
Test Files  16 passed (16)
     Tests  161 passed (161)

$ cd app/backend && pnpm test:integration
$ vitest run --project integration
Test Files  20 passed (20)
     Tests  106 passed (106)

$ cd app/backend && pnpm audit --audit-level=high
No known vulnerabilities found

$ cd app/backend && pnpm audit --audit-level=high --prod
No known vulnerabilities found

$ cd app/backend && pnpm drizzle-kit check
Everything's fine 🐶🔥

$ cd app/backend && pnpm install --frozen-lockfile
Already up to date
Done in 23ms using pnpm v11.0.0
```

**Counts:** 161 unit ✅ / 106 integration ✅ — matches baseline.

### Frontend
```
$ cd app/frontend && pnpm lint
$ oxlint
(exit 0 — clean)

$ cd app/frontend && pnpm test
$ vitest run
Test Files  1 passed (1)
     Tests  5 passed (5)

$ cd app/frontend && pnpm build
$ tsc -b && vite build
✓ built in 161ms

$ cd app/frontend && pnpm test:e2e
$ playwright test
Running 16 tests using 8 workers
16 passed (9.1s)
```

**Counts:** 5 frontend unit ✅ / 16 e2e ✅ — matches baseline.

### CI YAML
```
$ python -c "import yaml;yaml.safe_load(open('.github/workflows/ci.yml'))"
YAML OK
```

---

## B. Findings

### B1 — `vitest.config.ts` missing trailing newline (non-blocking)

The diff shows `vitest.config.ts` loses its trailing newline:
```diff
-});
+});
\ No newline at end of file
```

Verified: `Get-Content "app/backend/vitest.config.ts" | Select-Object -Last 1` returns `});` with no newline. The `Read` tool shows the file ends at line 58 with `});`.

This is cosmetic — POSIX prefers files to end with a newline — but some tools (diff, linters) may warn. Non-blocking.

### B2 — Untracked `logs_86137047854/` directory in working tree (non-blocking)

An untracked directory `logs_86137047854/` exists in the repo root containing `0_backend.txt`, `0_frontend.txt`, `backend/`, `frontend/` subdirectories. Dated 2026-08-14. Not tracked in git, not part of phase 10, not mentioned in the report. Should be added to `.gitignore` or removed. Non-blocking.

### B3 — All report claims verified as TRUE

| Claim | Verified | Evidence |
|---|---|---|
| vitest `^2.1.0` → `^4.1.11` | ✅ | `package.json:50` shows `"vitest": "^4.1.11"` |
| `vite@^8.2.2` added as explicit devDep | ✅ | `package.json:49` |
| `vitest.workspace.ts` deleted | ✅ | `Test-Path` returns False; grep finds no imports |
| Projects migrated to `vitest.config.ts` `test.projects` | ✅ | `vitest.config.ts:26-56` shows two projects |
| `poolOptions.forks.singleFork` → `maxWorkers: 1` | ✅ | `vitest.config.ts:42` |
| `ReturnType<typeof vi.fn>` → `Mock<T>` in otp-acquisition.test.ts | ✅ | diff confirms import + type change |
| `drizzle-orm` `^0.36.0` → `^0.45.2` | ✅ | `package.json:24` |
| `drizzle-kit` `^0.28.0` → `^0.31.10` | ✅ | `package.json:44` |
| `pg-errors.ts` created with cause-chain walking | ✅ | File exists, 26 lines, `pgErrorCode` + `isUniqueViolation` |
| `isUniqueViolation` imported by `runs.ts` and `auth.ts` | ✅ | `runs.ts:15`, `auth.ts:25`; old inline versions removed |
| Old inline `isUniqueViolation` in `auth.ts` deleted | ✅ | diff shows 8-line removal replaced by import |
| Old inline `isUniqueViolation` in `runs.ts` deleted | ✅ | diff shows 8-line removal replaced by import |
| `date-holidays` `^3.23.12` → `^3.35.0` | ✅ | `package.json:23` |
| `mailparser` `^3.7.2` → `^3.9.15` | ✅ | `package.json:29` |
| `imapflow` `^1.3.3` → `^1.7.2` | ✅ | `package.json:28` |
| `node-cron` `^3.0.3` → `^4.6.0` | ✅ | `package.json:30` |
| `@types/node-cron@3` removed | ✅ | not in `devDependencies` |
| `scheduler.ts` uses `void task.stop()` | ✅ | `scheduler.ts:62-63` |
| Two scoped `pnpm.overrides` in workspace.yaml | ✅ | `pnpm-workspace.yaml:16-25`, scoped to declaring edge |
| `esbuild@~0.18.20` resolves to `0.28.1` | ✅ | `pnpm why esbuild` confirms |
| `html-to-text@10.0.0` resolves to `10.0.1` | ✅ | `pnpm why html-to-text` confirms 10.0.1 |
| `ip-address` re-resolved to 10.5.0 | ✅ | `pnpm why ip-address` confirms |
| CI: `--prod` audit BLOCKING (no `continue-on-error`) | ✅ | `ci.yml:20` |
| CI: full-tree audit non-blocking (`continue-on-error: true`) | ✅ | `ci.yml:23-24` |
| `supply-chain-and-ci.md` updated with decision | ✅ | diff adds § 4 decision text |
| `drizzle-kit check` passes | ✅ | "Everything's fine" |
| No committed migration edited/added | ✅ | `git diff -- "app/backend/drizzle/"` empty |
| Ledger updated (STATE.md, BACKLOG.md, phase-10 file) | ✅ | diff confirms all three |

### B4 — Race guard red→green proof (VERIFIED)

**Step 1: Drop the correct index**
```
$ docker compose exec postgres psql -U sprout -d sprout_test -c "DROP INDEX IF EXISTS runs_one_active_per_user;"
DROP INDEX
```

**Step 2: Run race-guard test — expect FAIL**
```
$ pnpm vitest run --project integration test/integration/race-guard.test.ts
 ❯ test/integration/race-guard.test.ts (2 tests | 2 failed)
  FAIL: "allows exactly one of N concurrent starts" — expected [length 1] but got 8
  FAIL: "accepts a new run once the active one is finished" — expected 409 but got 202
```
Both tests go RED. Without the index, all concurrent inserts succeed (no unique constraint), and a second pending run is accepted.

**Step 3: Recreate the correct index**
```
$ docker compose exec postgres psql -U sprout -d sprout_test -c "DELETE FROM runs; CREATE UNIQUE INDEX runs_one_active_per_user ON runs USING btree (user_id) WHERE status IN ('pending', 'running');"
DELETE 2
CREATE INDEX
```

**Step 4: Run race-guard test — expect PASS**
```
$ pnpm vitest run --project integration test/integration/race-guard.test.ts
 Test Files  1 passed (1)
      Tests  2 passed (2)
```
Both tests go GREEN.

**Note:** I initially recreated the index with the wrong definition (`(user_id, action) WHERE status = 'pending'`) — matching the schema.ts but not the actual DB. The second test failed because it uses different actions (`"in"` then `"out"`). The real `sprout` DB has the correct index: `(user_id) WHERE status IN ('pending', 'running')`. I corrected the recreation and re-verified. This is a schema.ts drift issue, not a phase-10 defect.

### B5 — pg-errors.ts helper proven load-bearing (VERIFIED)

**Step 1: Temporarily revert `isUniqueViolation` to old pattern (direct `err.code`)**
```typescript
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}
```

**Step 2: Run race-guard test — expect FAIL**
```
$ pnpm vitest run --project integration test/integration/race-guard.test.ts
 ❯ test/integration/race-guard.test.ts (2 tests | 2 failed)
  FAIL: "allows exactly one of N concurrent starts" — expected [length 1] but got 8
  FAIL: "accepts a new run once the active one is finished" — expected 409 but got 500
```
Both tests go RED. With Drizzle 0.44+ wrapping, `err.code` is `undefined` (the code is on `.cause`), so `isUniqueViolation` never matches, the 23505 catch is skipped, and the error propagates as a 500.

**Step 3: Restore `pg-errors.ts`**
```
$ git diff -- app/backend/src/lib/pg-errors.ts
(no output — restored)
```

**Step 4: Verify test passes again**
```
$ pnpm vitest run --project integration test/integration/race-guard.test.ts
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

**Conclusion:** The `pg-errors.ts` cause-chain walker is essential. Without it, both the race guard (`runs.ts:50`) and the duplicate-email catch (`auth.ts:154`) silently return 500 instead of their intended status codes.

### B6 — Database state verified post-test

```
$ docker compose exec postgres psql -U sprout -d sprout_test -c "SELECT indexdef FROM pg_indexes WHERE indexname = 'runs_one_active_per_user';"
CREATE UNIQUE INDEX runs_one_active_per_user ON public.runs USING btree (user_id) WHERE (status = ANY (ARRAY['pending'::text, 'running'::text]))
```

Index is correct and matches production `sprout` DB definition.

---

## C. What I could not verify

These are `[manual]` items from the phase file that require a human or live infrastructure:

| # | Check | Why I cannot verify |
|---|---|---|
| 1 | `docker compose up -d --build`, then log in — boots clean, no config or migration errors | Requires running the full Docker stack end-to-end; I ran gates in dev mode only |
| 2 | Apply migrations to an empty scratch DB, diff schema against `sprout` — identical tables, indexes, constraints | The coder scripted this and reported it passed; I did not independently run the scratch-DB migration + diff |
| 3 | One real "Clock in now" against live HRHub — completes with sensible step log | Requires live HRHub credentials and a real browser session |
| 4 | "Test Gmail connection" — still connects after `imapflow` bump | Requires live Gmail App Password and IMAP connection |
| 5 | Push and open Actions tab — both CI jobs green | Requires a real push to GitHub and watching the Actions run |
| 6 | Real boot with `docker compose up -d --build` in production mode | Requires `NODE_ENV=production` + real secrets + real compose stack |

---

## D. Verdict

**Clean to commit.** No blocking findings. Two non-blocking items:

1. **B1:** `vitest.config.ts` missing trailing newline — cosmetic, can be fixed in the same commit or left.
2. **B2:** Untracked `logs_86137047854/` in working tree — pre-existing, not from this phase; should be cleaned up separately.

All report claims verified as true. Race guard red→green proof confirmed. pg-errors.ts helper proven load-bearing. CI audit structure correct. Overrides scoped and resolved. `drizzle-kit check` passes. No migrations touched. Ledger updated.
