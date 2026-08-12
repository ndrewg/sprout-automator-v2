# Phase 8 — review addendum (tester)

Hand to the reviewer alongside the implementer's Handoff report. I tried to make every claim in the report false; the gates are re-run, the tests were deliberately broken, and the rate-limit keying was attacked. One **BLOCKING** defect was found (B1).

---

## A. Structural verification — confirm, don't redo

**Gates re-run from a clean-ish working tree (implementer's uncommitted state):**

- `pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration` (app/backend) → **all green**: oxlint clean, `tsc --noEmit` clean, **16 files / 121 tests** unit passed, **19 files / 100 tests** integration passed. Matches the report.
- `docker compose config` → all eight keys rendered under `backend.environment`: `APP_URL`, `AUTH_RATE_LIMIT`, `MAIL_FROM`, `MAX_CONCURRENT_RUNS`, `MISSED_RUN_GRACE_MINUTES`, `RESEND_API_KEY`, `SIGNUP_ALLOWED`, `TRUST_PROXY_HOPS`. Whole-phase gate grep (`APP_URL|AUTH_RATE_LIMIT|SIGNUP_ALLOWED|TRUST_PROXY_HOPS`) counts **4**. Matches the report.
- `git ls-files jar` → **nothing**. `jar` is staged-deleted; `.gitignore:44-48` now carries `*.jar`, `jar`, `cookie*`, `*.cookies`, `cookies.txt`.
- `docker compose -f docker-compose.yml -f docker-compose.prod.yml config` → `NODE_ENV=production`, `APP_URL: https://sprout.yourdomain.com`, numeric dials empty (no overlay defaults), `ports: !reset []` intact.

**8A compose contract (no defaults for the phase's keys):**
- `docker-compose.yml:54-61` — the eight keys use plain `${KEY}`, no `:-` forms. The only `:-` defaults left in the base file are **pre-existing** (`SPROUT_URL` at :47, `NODE_ENV` at :41, `TZ` at :62, `BACKEND_PORT` at :64) — not introduced here. Note: `SPROUT_URL`'s compose default duplicates `config.ts`, so "config.ts is the single source of truth" is not fully realized repo-wide; values agree today, and it is out of scope for this phase. Flagged for completeness only.
- `docker-compose.prod.yml:58-60` — numeric dials plain `${KEY}`; `APP_URL` keeps the documented prod placeholder (:50); `SIGNUP_ALLOWED`/`RESEND_API_KEY`/`MAIL_FROM` keep their empty passthroughs (:55-57). Consistent with the phase's as-built note #2.
- **Cross-check (config.ts ↔ .env.example ↔ compose):** `config.ts` has 15 keys. All 15 appear in `.env.example` (verified by reading it) and all 15 appear in `backend.environment` (compose). No key present in one and absent in another. `TRUST_PROXY_HOPS` is the only new key and the phase names it.

**8B default 30:**
- `config.ts:60-64` — default 30 sits inside `z.preprocess(emptyToUndefined, …)`.
- `test/lib/config-defaults.test.ts` — pins `AUTH_RATE_LIMIT`=30 and `TRUST_PROXY_HOPS`=1.
- `test/integration/signup-rate-limit.test.ts` — loop bound and assertions derived from `config.AUTH_RATE_LIMIT`; the file's ratelimit-policy checks for the four reset endpoints also derive it.
- **Discrimination proven (see B2).**

**8C clientIp / TRUST_PROXY_HOPS:**
- `middleware/security.ts:46-53` — `clientIp` is exactly as reported: header value used when `node:net isIP() !== 0`, else `req.ip ?? req.socket.remoteAddress ?? "unknown"`; trims first.
- `security.ts:104` (authLimiter) and `:115` (apiLimiter) key on `clientIp`; `notificationsTestLimiter` (:126-134) untouched, still user-id keyed.
- `app.ts:37` — `app.set("trust proxy", config.TRUST_PROXY_HOPS)`; default 1 (`config.ts:72-73`), pinned by `config-defaults.test.ts`.
- **express-rate-limit warning claim verified.** Installed `express-rate-limit@7.5.1`. Source `dist/index.cjs:655-660`: the `ip`/`trustProxy`/`xForwardedForHeader` validations run **only inside the default `keyGenerator`**; a custom `keyGenerator` replaces it entirely, so they never run. No `ERR_ERL_*` or trust-proxy warnings appeared in the full gate run or in a live boot probe (tsx against the real app with container-like empty-string env). As-built note #3 is accurate; the deliberate-skip comment at `security.ts:91-97` is honest.
- `client-ip.test.ts` — 9 unit tests (valid v4/v6, trim, malformed, out-of-range octet, empty, absent, socket fallback, never-return-malformed). I cross-checked `isIP` edge cases against `node:net` directly: `""`/`not-an-ip`/overlong/`198.51.100.999` → 0 (fallback); `1.2.3.4`, `5.6.7.8`, `2001:db8::1` → valid (keyed on). The malformed-vector claims hold.

**No scope creep, no deps, no DB, no migration:**
- Diff contains no `ADMIN_EMAILS` (deferred), no screenshot-pruning code, no email-keyed limiter (still IP-keyed). Only doc mentions in STATE.md renumbering.
- No `package.json` / `pnpm-lock.yaml` / `drizzle/` changes (git diff clean there). 11 tracked drizzle files untouched.
- `docker compose exec postgres psql -U sprout -d sprout -c "\dt"` → 9 tables, untouched.
- Working tree after my probes is byte-identical to the implementer's state (verified via `git status --short` and grep for tamper markers).

**Live boot probe (tsx, real app, container-like env):** with `APP_URL=""`, `AUTH_RATE_LIMIT=""`, `MAX_CONCURRENT_RUNS=""`, `MISSED_RUN_GRACE_MINUTES=""`, `TRUST_PROXY_HOPS=""` set, the app boots and resolves `APP_URL=http://localhost:3000`, `AUTH_RATE_LIMIT=30`, `MAX_CONCURRENT_RUNS=3`, `MISSED_RUN_GRACE_MINUTES=20`, `TRUST_PROXY_HOPS=1`. Confirms the `emptyToUndefined` divergence's fix end-to-end outside a container.

---

## B. Defects found

### B1. **BLOCKING** — `clientIp` trusts a client-supplied `CF-Connecting-IP` unconditionally; the auth budget can be evaded and poisoned

`middleware/security.ts:46-53` honors `CF-Connecting-IP` whenever it parses as an IP literal. Nothing gates it — no trusted-proxy check, no config flag, no socket-peer verification. The phase's own contract (`phase-8-environment-and-limits.md` line 65) says *"Never trust a client-supplied CF-Connecting-IP when the header could be spoofed by a direct connection"* — the implementer's IP-literal validation does not achieve that: **any attacker can supply a valid IP literal.** The header is attacker-controlled in every deployment this phase targets today:

- **Base compose** (`docker-compose.yml:63-64`, backend directly on `localhost:3000`): a client on the host/LAN sets `CF-Connecting-IP: <any valid IP>` and the limiter keys on it.
- **Prod compose** (`docker-compose.prod.yml` adds Caddy): **verified end-to-end** with the real `caddy:2-alpine` image — a client-set `CF-Connecting-IP: 198.51.100.9` reaches the origin verbatim (`"cf-connecting-ip":"198.51.100.9"`), while Caddy sets `X-Forwarded-For` to the real client. `req.ip` behind Caddy is unforgeable (trust proxy=1 ⇒ req.ip = rightmost XFF entry = Caddy's view of the client), but the new `keyGenerator` overrides it with the attacker's header.

Concrete failure scenarios (both proven against the real app over real HTTP, harness = real Express app):

1. **Evasion.** Rotate `CF-Connecting-IP` per request → every request keys on a fresh bucket → the 30/15 min budget is never exhausted. **Probe:** 40 `POST /auth/signup` requests, each with a distinct forged `CF-Connecting-IP` → **0×429, all 403** (test/probe run against the real app; under the previous req.ip keying the 31st would have been 429). Unrestricted login brute-force, signup probing, and forgot-password mailbox flooding. This defeats the whole point of 8B + 8C.
2. **Poisoning.** Claim another address in the header and fill that bucket → the real user behind that IP is locked out of login/signup/reset for 15 min (repeatable DoS). Same-IP-shared-bucket is proven by the implementer's own alice/bob integration test.

Regression vs. pre-change: in the **prod/Caddy** deployment — the one the phase is explicitly building toward — pre-change keying was on the Caddy-set real client IP (secure); post-change it is on attacker input. In the **base** direct-exposure deployment the same class of hole pre-existed via `X-Forwarded-For` under the old hardcoded `trust proxy: 1` (a direct peer is trusted as one hop), so there this is a second vector, not a new capability. Either way the shipped code trusts a spoofable header for a security-critical function.

**Suggested fix direction (for the implementer; not applied):** gate the header on the request actually arriving from a trusted channel — e.g. only honor `CF-Connecting-IP` when the socket peer is a trusted tunnel/CF address, or behind an opt-in flag that defaults **off** and is only turned on once a real Cloudflare tunnel exists. Until then, key on `req.ip`.

`apiLimiter` (`security.ts:115`) shares the same trust; lower severity (authenticated routes, DoS-grade) but the same root cause.

### B2. The derived rate-limit test is **not** vacuous — but only because of the pair of tests, not either alone

The concern: `signup-rate-limit.test.ts` derives its loop bound from the same `config.AUTH_RATE_LIMIT` the limiter reads, so it can't detect a wrong *default*. That gap is closed by `config-defaults.test.ts` pinning 30. The derived test still discriminates against a broken *enforcement*:

- **Proven red when the limiter is broken.** I tampered `security.ts` `limit: config.AUTH_RATE_LIMIT` → `limit: 1000000` and ran the file: all 3 tests failed — `expected 403 to be 429` (the 31st request was let through) and `expected '1000000;w=900' to be '30;w=900'` (ratelimit-policy header reflects the real limit). Restored the file and re-ran green (3/3). No tamper markers remain.
- The `ratelimit-policy` header assertions in both `signup-rate-limit.test.ts` and `email-verification.test.ts` add a second discriminator: the header is emitted by express-rate-limit from the *actual* configured limit, so a hardcoded limit diverging from config fails the header assertion even where the 403/429 split would be ambiguous.

No finding here; the pair is sound.

### B3. Minor observation (not a phase-8 regression): pre-existing compose defaults remain

Base compose still carries compose-side defaults for `SPROUT_URL`, `NODE_ENV`, `TZ`, `BACKEND_PORT`, and the prod overlay for `APP_URL` + the string passthroughs. `SPROUT_URL`'s default duplicates `config.ts`. Pre-existing, values agree today, and the phase's seven/eight keys are clean — noted so the "single source of truth" ideal isn't assumed complete.

---

## C. What I could not verify

- **The three `[manual]` Docker boot rows** (8B/8C value-crossing proof): `AUTH_RATE_LIMIT=15` → 16th login 429; unset → 31st 429; clean `docker compose logs`. I did not build the container. My native boot probe with container-like empty-string env is a strong but not identical signal — only a real `docker compose up -d --build` with the real `.env` proves the value crosses the container boundary. That is the entire point of the phase; do not treat my probe as it.
- **Behavior behind a real Cloudflare Tunnel.** No tunnel exists; untested. (Cloudflare itself overwrites `CF-Connecting-IP` with the visitor IP, so the header would be trustworthy behind a genuine tunnel — which is exactly why the B1 fix should key trust on the tunnel actually being present.)
- **`pnpm build` and the e2e suite** — not part of the phase gate; not run.
- **Long-window bucket behaviour** (15 min `windowMs` reset) — the store semantics are express-rate-limit's, not this phase's; not re-probed beyond the existing tests.
- **Caddy header handling in the tunnel mode** — irrelevant today; today's Caddyfile (`reverse_proxy backend:3000`, no `header` directive) forwards the client header, which I proved.

## D. `[manual]` checks — for the human, results column empty

| # | Check | Command / what a pass looks like | Result |
|---|---|---|---|
| 1 | Value crosses the container boundary (raise budget) | Put `AUTH_RATE_LIMIT=15` in `.env`, `docker compose up -d --build`, fail login 16× (wrong password) → the **16th is 429** | |
| 2 | New default is live | Unset `AUTH_RATE_LIMIT`, restart, fail login 31× → the **31st is 429** | |
| 3 | Clean boot, no validation warnings | `docker compose logs backend --tail 5` after restart → boots clean; no config-validation errors, no rate-limit/trust-proxy validation warnings (`ERR_ERL_*`, "trust proxy") | |
| 4 | (B1 live demo, **superseded by the fix**) | Against the running container, fire 40 signups each with a fresh `curl -H "CF-Connecting-IP: 203.0.113.<N>"` → the **31st is now 429** (the header is ignored, so all 40 share the real client's bucket). 0×429 would mean the trusted-peer gate is not active | |
| 5 | (B1 poisoning live demo, **superseded by the fix**) | 30 requests with `CF-Connecting-IP: <any-value>`, then one real login without the header → the real login's outcome is **unchanged by the 30 forged requests** (they exhausted the *requester's own* bucket, not the header value's). A poisoned-lockout would mean the header is still trusted | |

---

## Round 2 (review round 2 of the B1 security correction) — tester

I tried to make the round-2 claims false: every gate re-run from the implementer's uncommitted working tree, every changed/added test deliberately broken, and the `clientIp` fix re-attacked over real HTTP. **B1 is closed for the `CF-Connecting-IP` vector.** One pre-existing residual evasion vector (via `X-Forwarded-For`) is documented below as B4; it is not a round-2 regression. I did not fix anything and staged nothing; every tamper was restored byte-identical (hash-checked) and the final full gate is green.

### A. Structural verification this round

**Gates re-run:**
- `pnpm lint && pnpm typecheck && pnpm test` → oxlint clean, `tsc --noEmit` clean, **16 files / 124 tests** unit passed.
- `pnpm test:integration` → **19 files / 101 tests** passed (Postgres up via `docker compose up -d postgres`).
- `docker compose config` (stdout only) → the whole-phase grep `APP_URL|AUTH_RATE_LIMIT|SIGNUP_ALLOWED|TRUST_PROXY_HOPS` counts **4**; all eight phase keys render under `backend.environment` with unset keys as `""`. Matches the report.
- `docker compose -f docker-compose.yml -f docker-compose.prod.yml config` → `NODE_ENV=production`, `APP_URL: https://sprout.yourdomain.com`, numeric dials empty, `ports: !reset []` intact. Matches the report.
- `git ls-files jar` → nothing; `.gitignore:23-27` carries `*.jar`, `jar`, `cookie*`, `*.cookies`, `cookies.txt`.

**The fix, as shipped:** `security.ts:52` `let trustedCloudflarePeers: ReadonlySet<string> = new Set()` (empty default); `security.ts:85-95` `clientIp` honours `CF-Connecting-IP` only when `normalizePeer(req.socket.remoteAddress)` is in the set **and** the value passes `node:net isIP()`; otherwise returns `req.ip ?? req.socket.remoteAddress ?? "unknown"`. `authLimiter`/`apiLimiter` key on `clientIp` (`security.ts:147,158`); `notificationsTestLimiter` still user-id keyed (`security.ts:173`). Test seam `setTrustedCloudflarePeers` (`security.ts:59-61`); `resetRateLimits` also restores the empty set (`security.ts:34`). Defaults: `AUTH_RATE_LIMIT=30` (`config.ts:60-64`), `TRUST_PROXY_HOPS=1` (`config.ts:74-75`), `emptyToUndefined` preprocess (`config.ts:11-12`) so Compose's `""` behaves like absent.

**Test-discrimination probes — every changed/added test was broken and went red (then restored, then green):**

| Probe | Tamper | Result |
|---|---|---|
| P1 | `config.ts` defaults 30→42 and 1→2 | `config-defaults.test.ts` both tests fail (`expected 42 to be 30`, `expected 2 to be 1`) — **discriminates** |
| P2 | `security.ts` authLimiter `limit` → 1000000 | all 4 `signup-rate-limit` tests fail (`expected 403 to be 429` ×3 and `'1000000;w=900' to be '30;w=900'`) — **discriminates** |
| P3 | remove the peer gate (honor header unconditionally — reintroduces B1) | 4 `client-ip` untrusted-peer tests fail — **discriminates** |
| P4 | never honor the header | trusted-peer integration test fails (`expected 429 to be 403`) — **discriminates** |
| P5 | never honor the header | 2 `client-ip` trusted-path unit tests fail — **discriminates** |
| P6 | authLimiter `limit` → 1000000 | `email-verification.test.ts` ratelimit-policy assertion fails (`'1000000;w=900' to be '30;w=900'`) — **discriminates** |

After every restore, source files were hash-identical to the pre-probe state and the full gate re-ran green (124 + 101).

### B. Findings — round-1 findings vs the current code

| Round-1 finding | Status | Evidence |
|---|---|---|
| **B1 (BLOCKING)** — `clientIp` honoured any well-formed `CF-Connecting-IP`; evasion + poisoning | **CLOSED** | Peer gate `security.ts:86-93`; probes P3/P4/P5 go red against the correct code's tests; real-HTTP A1/A2 below return the 31st request as 429. |
| **B2** — "derived test may be vacuous" | **Not a finding** | P1 + P2 prove the pair discriminates (config-defaults vs enforcement-break). |
| **B3** — pre-existing compose defaults remain (`SPROUT_URL`, `NODE_ENV`, `TZ`, `BACKEND_PORT`, prod `APP_URL` + string passthroughs) | **Still present** | Unchanged in this round's diff; observation stands, not a defect. |

**Real-HTTP attack probes** (temp integration test against the real app + real Postgres, deleted after):

- **A1 (evasion via rotating `CF-Connecting-IP`):** 31 signups, each with a fresh valid header value `203.0.113.<N>` → tail `[403, 403, 403, 429]`. The 31st is 429 despite 31 distinct values. **Evasion closed** (round 1's equivalent probe returned 0×429).
- **A2 (malformed / duplicate / IPv6 / empty / whitespace values):** cycling `["203.0.113.1","203.0.113.2"]` (array form), `not-an-ip`, `198.51.100.999`, `""`, `2001:db8::5`, `"  203.0.113.6  "` → tail `[403, 403, 403, 429]`. No value splits the bucket. **Malformed/duplicate vectors closed.**
- **A3 (direct `X-Forwarded-For` spoof, `TRUST_PROXY_HOPS=1`):** 31 signups, each with a fresh `X-Forwarded-For: 203.0.113.<N>` → **all 403, 0×429**. The budget is evaded by rotating XFF. **This is B4 below.**

### B4. Residual (pre-existing, not a round-2 regression) — `X-Forwarded-For` evasion in the base direct-exposure deployment

`TRUST_PROXY_HOPS=1` (default) + the base compose exposing the backend directly on `3000` means Express sets `req.ip` = the rightmost `X-Forwarded-For` entry on a direct connection. A client that connects straight to the backend and rotates XFF gets a fresh auth bucket per request — the same evasion B1 described, via a different header. Proven against the real app (A3: 0×429). It predates phase 8 (the pre-phase-8 limiter keyed on `req.ip` with the same hardcoded `trust proxy: 1`), and it is **not** reachable behind Caddy: Caddy appends the real client IP, so `req.ip` stays unforgeable there.

This is unchanged by the round-2 fix, which is why I do not block the commit on it — but it means "a spoofed header cannot rotate the budget" is only true for `CF-Connecting-IP`, and only in the Caddy deployment for XFF. Recommend a follow-up: bind the base compose's published port to the host loopback (`"127.0.0.1:${BACKEND_PORT:-3000}:3000"`) and/or set `TRUST_PROXY_HOPS=0` when the backend is not behind a proxy. Flagging for the reviewer to decide scope.

### B5. Minor (fail-closed footguns, not holes)

- **`normalizePeer` only normalises the socket peer, not the trusted-set entries.** Node reports IPv4 peers as `::ffff:<ip>` (visible in the harness logs); `normalizePeer` strips that so a peer added to the set in plain form matches. If an operator instead adds the mapped form they saw in logs (e.g. `::ffff:1.2.3.4`), it will **never** match and the trusted path silently stops working (header ignored) — fails closed, but confusing. Worth a doc note or normalising set entries too.
- **No automated test pins the Compose `""` → default path.** `config-defaults.test.ts` tests the *unset* path only; the empty-string path (`emptyToUndefined`) is verified by hand (round-1 live boot probe) but has no unit test. A one-line unit test (`process.env.AUTH_RATE_LIMIT = ""` → 30) would pin the exact behaviour 8A's as-built note #1 depends on.

### B6. Repo hygiene — `.cortexkit/` is untracked and not gitignored

`.cortexkit/` is the Magic Context tool's per-project state directory (empty `magic-context/historian/` + a nested `.gitignore` that ignores `magic-context/`). It does **not** belong in the repo and currently contains **nothing sensitive**. It is not covered by the repo's `.gitignore`, so the nested `.cortexkit/.gitignore` (75 bytes) **would be staged by a blanket `git add .` / `git add -A`** — proven via `git add -n .` (reports `add '.cortexkit/.gitignore'`). The commit rules ("stage deliberately, name the files") already protect against this; optionally add `.cortexkit/` to the repo `.gitignore`. (Oddity for the reviewer: `git check-ignore -v ".cortexkit/"` reports `.gitignore:38: .cortexkit/` although no such pattern exists in any gitignore I could find; `git status` and `git ls-files --others --exclude-standard` treat the nested `.gitignore` as addable, which is the behaviour that matters.)

**Deferred items still absent:** no screenshot-pruning code, no `ADMIN_EMAILS`/`requireAdmin`/admin route (grep of `src/` finds only pre-existing screenshot *capture* code), no email-keyed limiter. **No migration generated:** `drizzle/` untouched (0000–0004 only), no `package.json`/`pnpm-lock.yaml` changes.

**Ledger:** every claim in the `STATE.md` phase-8 row is true right now (gates 124/101 re-verified; compose passthrough re-verified; `jar` gone; default 30; derived test; trusted-peer gate; prod overlay; `[manual]` outstanding; no `phase-8-complete` tag exists — `git rev-parse --verify` fails). The ledger is updated in the working tree to be committed with the code, per the loop; it is not premature in substance.

### C. What I could not verify

- **The three `[manual]` Docker boot rows** (AUTH_RATE_LIMIT=15 → 16th is 429; unset → 31st is 429; clean `docker compose logs`). I did not build the container. My probes ran the real Express app through the harness (real HTTP, real Postgres, real limiters), which is strong but not the same as the value crossing the container boundary.
- **Behavior behind a real Cloudflare Tunnel** — none exists; the trusted-peer path is exercised only via the test seam.
- **The XFF residual inside the actual Docker base deployment** — proven against the harness app (same trust-proxy config); not re-run in a container.
- **`pnpm build` and the e2e suite** — not part of the phase gate.
- The `git check-ignore` `.gitignore:38` output contradiction (B6) — could not explain; the `git add -n` evidence is authoritative.

### D. `[manual]` checks — for the human, results column empty

| # | Check | Command / what a pass looks like | Result |
|---|---|---|---|
| 1 | Value crosses the container boundary (raise budget) | Put `AUTH_RATE_LIMIT=15` in `.env`, `docker compose up -d --build`, fail login 16× (wrong password) → the **16th is 429** | |
| 2 | New default is live | Unset `AUTH_RATE_LIMIT`, restart, fail login 31× → the **31st is 429** | |
| 3 | Clean boot, no validation warnings | `docker compose logs backend --tail 5` after restart → boots clean; no config-validation errors, no rate-limit/trust-proxy validation warnings (`ERR_ERL_*`, "trust proxy") | |
| 4 | (B1 live demo, superseded by the fix) | Fire 40 signups each with a fresh `curl -H "CF-Connecting-IP: 203.0.113.<N>"` → the **31st is now 429** (header ignored, all 40 share the real client's bucket). 0×429 would mean the trusted-peer gate is not active | |
| 5 | (B1 poisoning live demo, superseded by the fix) | 30 requests with `CF-Connecting-IP: <any-value>`, then one real login without the header → the real login's outcome is **unchanged** by the 30 forged requests (they exhausted the requester's own bucket, not the header value's) | |

---

## Round 3 (2026-08-12) — tester

I tried to make every round-3 claim false: gates re-run from the implementer's uncommitted working tree, the rate-limiter thresholds re-proven **live against the real container**, the required-secret boot guard proven end-to-end, the CF-Connecting-IP gate attacked in both directions over real HTTP, every new test deliberately broken, and a genuinely clean `--no-cache` build checked for the corepack prompt. **No BLOCKING findings.** One coverage gap worth a reviewer's eye (B7). The `[manual]` rate-limit rows are now provable and are marked done with real output.

### A. Structural verification this round

**Gates re-run:**
- `pnpm lint && pnpm typecheck && pnpm test` → oxlint clean, `tsc --noEmit` clean, **16 files / 132 tests** unit passed.
- `pnpm test:integration` → **19 files / 101 tests** passed (Postgres up via `docker compose up -d postgres`).
- `docker compose config` and `docker compose -f docker-compose.yml -f docker-compose.prod.yml config` → both exit 0, **0× "is not set"** in either. Base renders `APP_ENCRYPTION_KEY`/`SESSION_SECRET` with real values from `.env`, all optional keys as `""`. Prod keeps `NODE_ENV=production`, `APP_URL: https://sprout.yourdomain.com`, numeric dials empty, `ports: !reset []` intact.
- `git ls-files jar` → nothing; `git add -n .` stages exactly the 13 round-3 files and nothing else (no `.cortexkit/`, `.env`, `data/`, `jar`).
- **No new dependencies, no migration:** `git diff --stat` on all four `package.json`/lockfiles → empty; `app/backend/drizzle/` untouched (0000–0004 only, `git status --short` empty there).

**Compose contract (item 1):**
- `docker-compose.yml:44-45` — `APP_ENCRYPTION_KEY` and `SESSION_SECRET` stay **bare `${KEY}`** (verified by reading; `DATABASE_URL` at :43 is composed inline from POSTGRES_* with pre-existing defaults, not a round-3 change). The comment at :48-56 names the bare-vs-`:-` distinction correctly.
- `docker-compose.yml:57-65` and `docker-compose.prod.yml:55-61` — every optional key is `${KEY:-}` (empty default) including the new `TRUSTED_CLOUDFLARE_PEERS`. No `${KEY:-<realdefault>}` form **introduced** by round 3; the pre-existing ones (`SPROUT_URL:-`, `NODE_ENV:-`, `TZ:-`, `BACKEND_PORT:-`, prod `APP_URL:-`) are unchanged from round 1 (B3), values still agree with config.ts.

**Boot-guard end-to-end (item 3):** commented out `APP_ENCRYPTION_KEY` in `.env`, `docker compose up -d --force-recreate backend` → the compose warning fires ("The \"APP_ENCRYPTION_KEY\" variable is not set. Defaulting to a blank string.") and the container **crash-loops** with `Error: Invalid environment configuration: - APP_ENCRYPTION_KEY: APP_ENCRYPTION_KEY must be a 32-byte hex string (64 chars)` (config.ts:96). Restored `.env` (hash-identical to backup), recreated → boots clean. The bare-`${KEY}` warning + empty→Zod-rejection path is intact; nothing silently defaults.

**`.env.example` ↔ config.ts ↔ compose cross-check:** config.ts has 16 keys now (adds `TRUSTED_CLOUDFLARE_PEERS`). All 16 appear in `.env.example` (commented or not) and all 16 reach the container environment (`docker compose config` backend.environment). `PORT`/`DATABASE_URL`/`DATA_DIR` are set literally in compose (:42-46), not interpolated — pre-existing and correct. No key in one and absent from another.

**`.cortexkit/`:** gitignored (`.gitignore:32`), untracked, absent from `e3f0878` and from `git add -n` output. Claim holds.

**Diff characterisation (item 2, the +72 lines in security.ts):** read the full diff — they are the `parseTrustedCloudflarePeers` function (12 lines), the two config-driven wiring lines (`security.ts:34-36` and `:75-77`), and ~50 lines of doc comments. `clientIp`'s gate logic (`:119-129`), the limiters (`:176-196`), `normalizePeer` (`:90-92`) and `setTrustedCloudflarePeers` (`:84-86`) are **unchanged**. The limits (`AUTH_RATE_LIMIT` default 30, per-IP 120/min apiLimiter) and keying are byte-identical to round 2. **Not a behavioural rewrite** — confirmed behaviourally by the live thresholds below.

### B. Findings

#### B7. Non-blocking — the round-3 headline wiring has NO automated test; only the parse and the seam are pinned

The whole point of round 3 was to make the trusted-peer set operator-configurable via `TRUSTED_CLOUDFLARE_PEERS`. That path is two lines: module-load (`security.ts:75-77`) and `resetRateLimits` (`:34-36`), both `parseTrustedCloudflarePeers(config.TRUSTED_CLOUDFLARE_PEERS)`. I deliberately broke **both halves separately** and the suite stayed fully green:

| Probe | Tamper | Result |
|---|---|---|
| W1 | module-load line → `new Set()` (ignores config) | **132/132 unit + 101/101 integration pass** — the wiring is unpinned |
| W2 | `resetRateLimits` → `new Set()` (round-2 behaviour) | **101/101 integration pass** — same |

No test anywhere sets `TRUSTED_CLOUDFLARE_PEERS` to a *value* and exercises `clientIp`; the only references are the unset-default assertion (`config-defaults.test.ts:55-58`) and the parse unit tests. Failure scenario: a future refactor deletes or mis-splices either wiring line and the suite stays green while a deployed team silently shares one auth bucket — the exact failure § 8C exists to prevent, now unguarded. It works **today** (proven live in A-direction below), so not blocking; but this is the one place where round 3's own feature is trusted-by-intent, not trusted-by-test. Suggest the reviewer note it for a later hardening pass (e.g. a unit test that sets the env var before importing security, or a config-injection seam).

**Test-discrimination probes — every new round-3 test was broken and went red (then restored, then green):**

| Probe | Tamper | Result |
|---|---|---|
| G1 | `parseTrustedCloudflarePeers` → always `new Set()` | split-list test fails (`expected Set{} to equal Set{...}`) — **discriminates** |
| G2 | parse keeps empty entries (`peers.add(part.trim())`) | both Compose-empty-form tests fail (`expected Set{''} to equal Set{}`) — **discriminates** |
| G3 | `emptyToUndefined` → identity in config.ts | all 4 new empty-string→default tests fail (loadConfig throws) — **discriminates** |
| G4 | gate forced off in `clientIp` (`if (false)`) | trusted-peer integration test fails (`expected 429 to be 403`) — **discriminates** |

After every restore, source files were hash-identical to the pre-probe state and the full gate re-ran green (132 + 101).

**Live threshold re-proof (item 2, against the real container, `.env` AUTH_RATE_LIMIT=15 then unset, `--force-recreate` between runs to clear the in-memory store):**
- `AUTH_RATE_LIMIT=15` → statuses `401 ×15, 429` — **the 16th is 429**. ✓
- unset → `401 ×30, 429` (exactly one 429, at position 31) — **the 31st is 429**. ✓
- `docker compose logs backend` after both boots: no `ERR_ERL_*`, no "trust proxy", no config-validation errors. ✓

**CF-Connecting-IP gate — both directions over real HTTP (item 4):**

| Scenario | Config | Probe | Result |
|---|---|---|---|
| Gate off (default) | `TRUSTED_CLOUDFLARE_PEERS` unset | 40 logins, each `CF-Connecting-IP: 203.0.113.<N>` | 30×401 + 10×429, **first 429 at 31** — one shared bucket. Safe default intact. |
| Gate on, trusted peer | `TRUSTED_CLOUDFLARE_PEERS=172.21.0.1` (the Docker bridge gateway the host's curl comes through), recreated | same 40 logins | **40×401, 0×429** — distinct valid values now get distinct buckets. The opt-in changes behaviour, so § 8C's purpose is met. |
| Gate on, trusted peer, malformed | same | cycle `[no header, not-an-ip, over-long, header-twice]` ×8 from the host | 30×401 + 429s, **first 429 at 31** — malformed values fall back to req.ip and share one bucket. |
| Gate on, UNtrusted peer | same, but curl from **inside** the container (socket peer 127.0.0.1, not in the set) | 40 logins each with distinct **valid** `CF-Connecting-IP: 203.0.113.<N>` | 30×401 + 429s, **first 429 at 31** — a valid literal from a non-trusted peer is still ignored (fail-closed even with the gate on). |
| Gate on, UNtrusted peer, all forms | same, inside container | cycle `[no-header, not-an-ip, 1.2.3.4, 5.6.7.8, over-long, IPv6, header-twice]` ×8 | first 429 at 31 — nothing from a non-trusted peer is keyed on, valid or not. |

The brief's item-4 malformed list includes `1.2.3.4`, `5.6.7.8` and IPv6 alongside the genuinely malformed forms. Those are valid literals, so the "none may be keyed on" claim is only true for the **untrusted-peer** variant (proven above); from a **trusted** peer they are correctly keyed on (that is the point of the feature, proven in row 2). Both readings hold; the doc comment (`security.ts:94-118`) states exactly this trust condition, and `DEPLOY.md:162-186` (§4.1) tells the operator what to set, how to find the peer, what forgetting costs (one shared bucket), and the Caddy caveat. ✓

**Corepack (item 5):**
- `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` is set **in both Dockerfile stages before any pnpm invocation**: `Dockerfile:9` (frontend stage, before `corepack enable pnpm` at :10 and `pnpm install` at :12) and `Dockerfile:21` (runtime stage, before `corepack enable pnpm` at :22 and `pnpm install` at :24). Not just the final stage.
- `setup.ps1:29` and `setup.sh:21` both export it before any docker/pnpm command.
- **Genuinely clean build** `docker compose build --no-cache backend`: **0× "Corepack is about to download"** in the full log; both stages re-ran `corepack enable pnpm` + `pnpm install` from scratch (frontend resolved 426 packages, runtime 161) and the frontend `pnpm build` completed. The env is effective under a genuinely cold build, not a cached-image artifact. ✓

**STATE.md ledger claims (item 6):** every round-3 claim in the phase-8 row and the B5 gap note is true right now: `${KEY:-}` switch, bare secrets, empty-string→default unit pins, the operator-facing `TRUSTED_CLOUDFLARE_PEERS` key wired through all three files, DEPLOY.md §4.1, both-stages corepack, and the live re-verification numbers (I reproduced 16th-429 / 31st-429 / 0 warnings / no prompt / `git ls-files jar` empty / drizzle untouched). The row's earlier `(124 unit, 101 integration)` figure is the round-1/2 record and is now superseded (132 unit) — the ledger row was not renumbered, which is fine for an as-built record but worth knowing.

### C. What I could not verify

- **A cold corepack cache on a fresh machine.** The `--no-cache` build re-runs every RUN step in a fresh container, which is the strongest local signal, but this host's pnpm was already downloaded inside earlier image layers and the OS-level corepack cache; the true "first build on a clean machine" case needs a fresh node:22 image and is the residual `[manual]` item.
- **Behaviour behind a real Cloudflare Tunnel** — the trusted-peer path was exercised with the Docker bridge gateway as the trusted peer; a genuine cloudflared→Express hop (and the header Cloudflare itself stamps) is only provable on a real tunnel.
- **`pnpm build` and the e2e suite** — not part of the phase gate; not run.
- **Long-window (15 min) bucket expiry** — express-rate-limit store semantics, unchanged, not re-probed.
- **The header-sent-twice array shape at the app level** — the malformed cycle included it; Node coalesces to an array and `clientIp` reads `raw[0]`. The round-1/2 array-form coverage (A2) still stands.

### D. `[manual]` checks — for the human, rate-limit rows now proven by the tester

| # | Check | Command / what a pass looks like | Result |
|---|---|---|---|
| 1 | Value crosses the container boundary (raise budget) | `AUTH_RATE_LIMIT=15` in `.env`, recreate, 16 wrong-password logins | ✅ **DONE (tester, 2026-08-12): `401 ×15, 429`** |
| 2 | New default is live | unset, recreate, 31 wrong-password logins | ✅ **DONE (tester, 2026-08-12): `401 ×30, 429`** |
| 3 | Clean boot, no validation warnings | `docker compose logs backend` after both boots | ✅ **DONE (tester, 2026-08-12): no ERR_ERL_*/trust-proxy/config errors** |
| 4 | Gate off: 40 forged headers share the real client's bucket | `CF-Connecting-IP: 203.0.113.<N>` ×40 → 31st is 429 | ✅ **DONE (tester, 2026-08-12): first 429 at 31** |
| 5 | Gate on: 40 distinct forged headers get distinct buckets | set `TRUSTED_CLOUDFLARE_PEERS` to the gateway, recreate, same probe → 0×429 | ✅ **DONE (tester, 2026-08-12): 40×401, 0×429** |
| 6 | **Real Cloudflare Tunnel → real per-client IPs reach the limiter** | put a tunnel in front, confirm distinct visitors get distinct auth buckets (and that a forged `CF-Connecting-IP` from a direct connection still cannot) | 🕐 human — the reason § 8C exists; untestable locally |

