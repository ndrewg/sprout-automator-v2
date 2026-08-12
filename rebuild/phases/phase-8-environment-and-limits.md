# Phase 8 — Environment and limits

**Goal:** make every config dial actually reachable, and make the IP the rate limiter keys on the real client. Small phase, high leverage — nothing else in the plan can be configured until this ships.

**Attach for this session:** `03-CONVENTIONS-AND-GUARDRAILS.md`, `04-STACK-SCAFFOLD-AND-CONFIG.md` (§ config), `reference/testing-strategy.md`.

> 📡 **Fetch live docs (Context7):** Docker Compose spec (environment interpolation), `express-rate-limit` v7 (`keyGenerator`, and its `trust proxy` validation warnings), Express 5 `trust proxy`. Do not write these from memory.

**Why this is first.** Three of the four things that scale with user count are config values (`AUTH_RATE_LIMIT`, `MAX_CONCURRENT_RUNS`, `SIGNUP_ALLOWED`), and none of them currently reach the container. Growing the cohort should be an env edit and a restart, not a code change. Today it is neither — it is a silent no-op.

**Scope note (decided 2026-08-12).** Screenshot pruning, admin visibility and the email-keyed limiter were considered for this phase and **deliberately deferred** — see `BACKLOG.md` §§ 2, 3, 8 for the reasoning. Do not implement them here.

---

## 8A — Compose passes the whole environment (`BACKLOG.md` § 4)

**The defect.** `config.ts` reads fourteen env keys. `docker-compose.yml`'s `backend.environment` block passes seven: `NODE_ENV`, `PORT`, `DATABASE_URL`, `APP_ENCRYPTION_KEY`, `SESSION_SECRET`, `DATA_DIR`, `SPROUT_URL` (plus `TZ`, which is not a config key). Setting any of the other seven in the root `.env` **does nothing under Docker, and nothing warns** — the container never sees them, so each falls back to its default.

Missing: `APP_URL`, `AUTH_RATE_LIMIT`, `MAIL_FROM`, `MAX_CONCURRENT_RUNS`, `MISSED_RUN_GRACE_MINUTES`, `RESEND_API_KEY`, `SIGNUP_ALLOWED`.

**Contract:**
- Add all seven to `docker-compose.yml` under `backend.environment` with `${KEY}` interpolation.
- **Do not invent defaults in compose.** `${AUTH_RATE_LIMIT}`, never `${AUTH_RATE_LIMIT:-30}`. `config.ts` is the single source of truth for defaults; a duplicated default is a second place to be wrong, and an unset key must behave identically inside and outside Docker.
- Mirror into `docker-compose.prod.yml` only for keys it overrides, without disturbing its `NODE_ENV=production` or the `ports: !reset []` backend override.
- `.env.example` already documents all fourteen — verify, and fix any that drifted.

**Repo hygiene, same gate.** `jar` at the repo root is a tracked curl cookie jar holding a live `sid` session cookie for `127.0.0.1`, committed in `a81c96d`. `git rm jar`. Widen `.gitignore`: the existing `cookies.txt` entry did not match a file written by `curl -c jar`. Add `jar`, `cookie*`, `*.cookies`. **Do not rewrite history** — the session is long dead and history rewriting is not worth it.

**Gate 8A:**
```
docker compose config | grep -E "APP_URL|AUTH_RATE_LIMIT|SIGNUP_ALLOWED|MAX_CONCURRENT_RUNS|MISSED_RUN_GRACE_MINUTES|RESEND_API_KEY|MAIL_FROM"
git ls-files jar          # must print nothing
cd app/backend && pnpm lint && pnpm typecheck && pnpm test
```
`docker compose config` renders the resolved file; all seven must appear under the backend service.

---

## 8B — Raise the auth budget (`BACKLOG.md` § 3, cheapest option)

**The defect.** `authLimiter` (`middleware/security.ts:67`) is `AUTH_RATE_LIMIT` (default **10**) requests / 15 min per IP, shared across login, signup, forgot-password and reset. Colleagues on one corporate network share one IP, so a handful of people signing up the same morning exhaust it for everyone.

**The decision (2026-08-12): raise the default, do not rewrite the keying.** `BACKLOG.md` § 3 lists three options; for a small trusted pilot the cheapest is sufficient, and after 8A it is a config change. The correct email-keyed version stays specced in § 3 for when the cohort grows past ~25.

**Contract:**
- `config.ts`: `AUTH_RATE_LIMIT` default **10 → 30**. That is the whole change.

**⚠️ This will turn an existing test red, and it is not a bug you introduced.**
`app/backend/test/integration/signup-rate-limit.test.ts:29` loops **exactly 11 times** and asserts `statuses[10] === 429`, hardcoding the old default.

- **Do not delete or skip it.** Rewrite it to derive its loop bound from `config.AUTH_RATE_LIMIT` — fire `limit + 1` requests and assert the last one is 429. The property being protected is "the budget is enforced", not "the number is 10", and deriving it means the next default change does not break it again.
- Add a unit assertion that the parsed default **is 30**, so a silent revert is caught.

**Gate 8B:** `cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration`

---

## 8C — Key the limiter on the real client IP

**Why now, before any tunnel exists.** `app.ts:32` hardcodes `app.set("trust proxy", 1)`. That is correct for a single reverse proxy. It is **wrong behind Cloudflare Tunnel**, where the chain is client → Cloudflare edge → `cloudflared` → Express, and Cloudflare puts the true client address in the **`CF-Connecting-IP`** header rather than at a predictable position in `X-Forwarded-For`.

Get this wrong and every request appears to come from one address, so `AUTH_RATE_LIMIT` becomes a **global** budget shared by all users — strictly worse than the NAT problem 8B just relieved, and it presents as random "Too many attempts" errors with no discernible pattern. Ten lines now prevents a confusing outage later.

**Contract:**
- New helper — `clientIp(req): string` — in `middleware/security.ts` (or a small sibling module): return `CF-Connecting-IP` when present and syntactically valid, else fall back to `req.ip`. **Never trust a client-supplied `CF-Connecting-IP` when the header could be spoofed by a direct connection** — and "parses as an IP literal" is NOT a trust check, only a validity check. The header is honoured **only when the request actually arrived from a trusted Cloudflare channel**: gate it on the socket peer being in a trusted-peer set (the address cloudflared connects from), which is **empty by default** because no Cloudflare Tunnel exists in any deployment today — so keying falls back to `req.ip` until a real tunnel is deployed and its peer address is added. Caddy must never be in the trusted set: it forwards a client-supplied header verbatim.
- Use it as the `keyGenerator` for `authLimiter` and `apiLimiter`. Leave `notificationsTestLimiter` alone — it keys on the user id by design (`security.ts:95`).
- Replace the hardcoded `trust proxy` value with a config key **`TRUST_PROXY_HOPS`** (int, default **1**, so today's behaviour is unchanged). Add it to `config.ts`, `.env.example` **and compose (8A)** — this phase must not create a fifteenth unreachable key.
- express-rate-limit v7 validates `trust proxy` against custom key generators and may emit warnings; if it does, configure the validation deliberately rather than silencing it blindly, and say which you chose in the report.

**Tests (unit + integration):**
- `clientIp` returns the `CF-Connecting-IP` value when it is a valid IPv4/IPv6 address **and the socket peer is a trusted tunnel peer**.
- `clientIp` **ignores** a `CF-Connecting-IP` from an untrusted peer — even a well-formed one — and falls back to `req.ip`.
- Two requests with **different** `CF-Connecting-IP` values do not share an auth budget **only when the peer is trusted**; from an untrusted peer, different spoofed values share one bucket (the attacker cannot rotate the header to evade the budget). This is the property the gate exists for.
- `TRUST_PROXY_HOPS` default is 1.

**Gate 8C:** `cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration`

---

> ⚠️ **As-built (found 2026-08-12):** three things differed from the text above when the phase was implemented.
>
> 1. **§ 8A/§ 8B needed a config.ts change the phase did not name.** `docker compose` interpolates an unset `${KEY}` to the **empty string** (verified empirically with Docker 29.7), so after 8A every unset numeric/URL dial arrives in the container as `""` — and `z.coerce.number()` turns `""` into `0`, failing `.min(1)`, while `.url()` rejects `""`. Without a fix, `docker compose up` refuses to boot for anyone not setting `APP_URL`, `AUTH_RATE_LIMIT`, `MAX_CONCURRENT_RUNS` and `MISSED_RUN_GRACE_MINUTES`. `config.ts` now runs those keys (and `TRUST_PROXY_HOPS`) through `z.preprocess(emptyToUndefined, …)` with the default **inside** the preprocess (zod's `.default()` only fires on `undefined`, so the `"" → undefined` conversion must happen before the default-bearing schema runs). This is what makes "an unset key behaves identically inside and outside Docker" actually true.
> 2. **§ 8A's `docker-compose.prod.yml` instruction.** "Mirror only for keys it overrides" + "no defaults in compose" was implemented as: the overlay keeps its genuine overrides (`NODE_ENV=production`, `ports: !reset []`, the `APP_URL` placeholder default `https://sprout.yourdomain.com` — removing it would break the tested phase-5 local-verification flow — and the empty-by-default `SIGNUP_ALLOWED`/`RESEND_API_KEY`/`MAIL_FROM` passthroughs), while `MAX_CONCURRENT_RUNS`/`MISSED_RUN_GRACE_MINUTES`/`AUTH_RATE_LIMIT` lost their `:-default` (they duplicated config.ts defaults, and `AUTH_RATE_LIMIT:-10` would have overridden the new default 30).
> 3. **§ 8C's express-rate-limit validation.** Verified against the installed v7.5 source: the `ip`/`trustProxy`/`xForwardedForHeader` validations run **only inside the default `keyGenerator`** — a custom `keyGenerator` skips them entirely, so supplying `clientIp` produces **no** warnings and no `validate:` overrides were needed or added. The deliberate choice is documented in `middleware/security.ts` above the limiters.
> 4. **§ 8C's "parses as an IP" trust gate was NOT sufficient — corrected 2026-08-12 (review round 2).** The contract as first written validated *syntactic validity*, but the header is attacker-controlled on every deployment this phase targets: the base compose exposes the backend directly, and the prod Caddy forwards a client-supplied `CF-Connecting-IP` **verbatim** (the tester proved this end-to-end with `caddy:2-alpine`). An attacker can supply a *well-formed* literal, so "valid IP" is a validity check, not a trust check — it only prevents merging everyone into one bucket, not rotating the header for a fresh budget (evasion) or claiming a victim's address (poisoning). The reviewer's B1 finding reproduced both against the real app. The shipped fix: `clientIp` now honours the header **only when `req.socket.remoteAddress` is in `trustedCloudflarePeers`** — a code constant, **empty by default** (no Cloudflare Tunnel exists in any deployment), keyed on the normalized peer address (IPv4-mapped IPv6 form stripped). It must be populated by hand when a real tunnel is deployed, with the address the backend sees from cloudflared; Caddy's address is deliberately excluded. `resetRateLimits()` also restores the empty set so the test seam `setTrustedCloudflarePeers` cannot leak across the single-fork integration suite. Unit and integration tests updated to the corrected property: an untrusted peer's spoofed header does **not** split the budget, while a trusted peer's does.
>
> > ⚠️ **Round-3 corrections (2026-08-12, after review rounds 1–2 and the `[manual]` Docker checks):**
> >
> > 1. **§ 8A's `${KEY}` passthrough was noisy and now uses `${KEY:-}`.** Every `docker compose` command printed seven `"variable is not set"` warnings and the container received `""` (empty) rather than an absent key for the seven optional keys. The bare form is now `${KEY:-}` for every optional key in **both** compose files — it supplies an *empty* default (killing the warnings) while keeping the identical empty-string passthrough that config.ts already treats as absent, so 8A's "unset behaves like absent" contract is unchanged. `${KEY:-30}` remains forbidden (a duplicated default). The required keys `APP_ENCRYPTION_KEY`/`SESSION_SECRET` stay bare `${KEY}`: a missing value there is a real problem and the warning is the signal. The empty-string→default resolution is now pinned by unit tests in `config-defaults.test.ts` (`AUTH_RATE_LIMIT`→30, `MAX_CONCURRENT_RUNS`→3, `TRUST_PROXY_HOPS`→1), not just by the live boot checks.
> > 2. **§ 8C's trusted-peer set became operator-configurable.** The peer gate was a code constant, so the tunnel path was *unreachable* outside tests — a deployed tunnel would silently share one global budget. The set is now populated from a new **`TRUSTED_CLOUDFLARE_PEERS`** env key (comma-separated peer addresses; empty = gate off, the safe default), wired through `config.ts`, `.env.example` and both compose files in the same change — no third mechanism. `clientIp`'s doc comment states the exact trust condition and the operator step; `parseTrustedCloudflarePeers` (exported, unit-tested) treats the empty-string Compose form exactly like an unset variable. The operator note lives in `DEPLOY.md` §4.1, referencing `BACKLOG.md` § 12.
> > 3. **Unattended-build fix:** `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` set in both Dockerfile stages and both `scripts/setup.{ps1,sh}`, so a cold rebuild cannot block on corepack's "about to download pnpm" prompt. Proven by a rebuild log with no prompt line; a cold-corepack-cache first build is the residual `[manual]` check.

---

## Verification Gate (the whole phase)

```
cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration
docker compose config | grep -cE "APP_URL|AUTH_RATE_LIMIT|SIGNUP_ALLOWED|TRUST_PROXY_HOPS"
git ls-files jar
```

**`[manual]` — must not be claimed as passed:**

| # | Check | Pass looks like |
|---|---|---|
| 1 | Put `AUTH_RATE_LIMIT=15` in `.env`, `docker compose up -d --build`, then fail login 16× | The 16th is 429 — proves the value reaches the container, which no test can |
| 2 | Unset it, restart, fail login 31× | The 31st is 429 — the new default is live |
| 3 | `docker compose logs backend --tail 5` after restart | Boots clean; no config validation errors, no rate-limit validation warnings |

Commit per the loop in `AGENTS.md` — implementer reports, tester probes, reviewer commits. Tag `phase-8-complete` when the `[manual]` rows are filled in.
