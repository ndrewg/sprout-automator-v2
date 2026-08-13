# Phase 8 follow-up — `TRUSTED_CLOUDFLARE_PEERS` fails silently

**Status:** non-blocking. Reviewed by reading `360d9b2` (no tests re-run). **Nothing here is wrong in the deployed posture today** — the gate is off, the header is ignored, and that is correct while no tunnel exists. Every finding below is a *"the day you enable the tunnel"* risk.

**Why it is worth a hardening pass anyway:** all five findings share one failure mode. The gate silently turns **off** — the header is ignored, every client collapses into one rate-limit bucket, and nothing in the logs says so. That is the exact § 8C failure the phase was written to prevent, reached by misconfiguration instead of by code. A security gate that can be silently disabled by a typo is a gate you cannot trust, and you will only find out when a colleague reports random "Too many attempts".

---

## F1 — Peer comparison is asymmetric on IPv4-mapped IPv6 (concrete)

`parseTrustedCloudflarePeers` only **trims** each entry:

```ts
const peer = part.trim();
if (peer !== "") peers.add(peer);
```

but the lookup side runs the socket address through `normalizePeer(req.socket.remoteAddress)`. On a Docker bridge network `remoteAddress` is commonly the IPv4-mapped form `::ffff:172.20.0.4`, which is presumably why `normalizePeer` exists at all.

So the two sides of the comparison are normalized differently. An operator who writes `::ffff:172.20.0.4` (or copies it out of a log line, which is where they will get it) produces a set entry that can never match the normalized peer — or vice versa, depending on which direction `normalizePeer` converts.

**Fix:** run every parsed entry through `normalizePeer` so both sides of the `has()` are in the same form. One line, and it removes a whole class of "I set it and it didn't work".

## F2 — A malformed entry is accepted and never matches

Any string is accepted into the set. `172.20.0.4;` , `cloudflared`, `172.20..4`, a stray quote from `.env` — each yields a non-empty set that matches nothing, i.e. the gate reports as configured and behaves as off.

**Fix:** validate each entry with `isIP` (already imported for `clientIp`) and **refuse to boot** on an invalid one, naming the offending position and the fix. This is exactly the precedent `SIGNUP_ALLOWED` set in 4A.2 and `ADMIN_EMAILS` will follow in phase 10: a bad security-relevant config value is a startup error, not a silent default. Do **not** log the addresses at `info` — a peer address is not a secret, but keep the message to positions and counts for consistency with the rest of the codebase.

## F3 — The gate is unobservable in both directions

There is no way to tell, from a running container, whether the gate is on and working.

**Fix, two log lines:**
1. **At startup:** log the size of the trusted-peer set (`{"trustedCloudflarePeers": 0}`). Zero is the normal, safe state; a `1` is the operator's confirmation that their change took effect.
2. **On mismatch, once:** when a `CF-Connecting-IP` header arrives while the set is **non-empty** but the peer is not in it, `warn` — including the observed peer address. That is the precise signature of F1, F2 and F4, and it converts every one of them from a silent misconfiguration into a visible one. Rate-limit or once-only it so a hostile client cannot flood the log.

## F4 — cloudflared's Docker IP is not stable

The config comment tells the operator to "set this to the address the backend sees from cloudflared". If `cloudflared` runs as a compose service, that address is assigned by the Docker bridge and **changes when containers are recreated** — which this project does routinely (`--force-recreate` appears throughout the phase-8 manual checks). So the gate works, then silently stops.

**Options, in order of preference:**
- Accept **CIDR** entries as well as literals (`172.20.0.0/16`) so the whole compose network can be trusted in one stable value. Note in the comment that this trusts any container on that network to set the header — acceptable when the network contains only your own services, and it is strictly better than a value that decays.
- Or assign `cloudflared` a **static IP** in compose and document that the two values must match.
- Or resolve the service name to an address at startup.

Whichever is chosen, `DEPLOY.md` § 4.1 must say that the value decays if containers are renumbered, and F3's mismatch warning is the safety net.

## F5 — `resetRateLimits` weakens the test seam (minor)

Round 3 changed the reset from `new Set()` to `parseTrustedCloudflarePeers(config.TRUSTED_CLOUDFLARE_PEERS)`. Harmless today because the test env leaves the key unset, but it means a future test env that sets the key would have `setTrustedCloudflarePeers` overrides silently reverted by the next reset, and the seam would stop doing what its name says.

**Fix:** either reset to the empty set (the safe posture, and what a test almost always wants), or document at the seam that a reset re-reads config so a test must re-apply its override afterwards.

## Already recorded — B7

`STATE.md` § Known gaps already notes that the two wiring lines (module-load and `resetRateLimits`) are uncovered: tamper with either and the suite stays green while a deployed tunnel shares one bucket. That is the same silent-failure family, and **F3's startup log is the cheapest partial answer to it** — a wiring break becomes visible in the boot log even without a test. A test that sets the env var before importing `security` remains the real fix.

---

## Implementer prompt

> You are working on **Sprout Automator**. Phase 8 is complete and committed (`360d9b2`); this is a small hardening follow-up on one key it introduced, `TRUSTED_CLOUDFLARE_PEERS`.
>
> **Read first:** `rebuild/STATE.md`, `AGENTS.md`, `rebuild/phases/phase-8-environment-and-limits.md` § 8C, `rebuild/reviews/phase-8-cf-peer-hardening.md` (this file, findings F1–F5).
>
> **Context that must not change.** The trusted-peer gate is correct and its default posture is correct: with the key unset, `CF-Connecting-IP` is never honoured and both limiters key on `req.ip`. A tester proved the earlier "parses as an IP literal" gate was bypassable for both evasion and poisoning, so **do not weaken the peer gate, do not trust the header on any additional condition, and do not add Caddy's address to any default.** These thresholds are human-verified and must still hold afterwards: with `AUTH_RATE_LIMIT=15` the 16th auth request is 429; unset, the 31st is.
>
> **Implement F1, F2, F3 and F5. For F4, implement CIDR support** (the first option) unless you find a concrete reason it cannot work, in which case stop and ask one specific question rather than choosing a different option silently.
>
> 1. **F1** — normalize every parsed peer entry through the same `normalizePeer` used on `req.socket.remoteAddress`, so both sides of the set lookup are in one form. Add a test where the entry is written in IPv4-mapped form (`::ffff:172.20.0.4`) and the peer arrives as `172.20.0.4`, **and the reverse**. Both must match.
> 2. **F2** — validate each entry (`isIP`, plus CIDR parsing from F4) and **refuse to boot** on an invalid one, with a message naming the position and the fix — same shape as the existing `SIGNUP_ALLOWED` production guard. Test that a malformed entry fails startup.
> 3. **F3** — log the trusted-peer set **size** at startup (never the addresses at `info`). Add a `warn`, rate-limited or once-only, for the case where a `CF-Connecting-IP` arrives while the set is non-empty and the peer is not in it; include the observed peer. Assert the warn fires in that case and does **not** fire when the set is empty (the normal state — it must not log on every request today).
> 4. **F4** — accept CIDR entries alongside literals. Tests: an address inside the range is trusted, one outside is not, and a bad mask fails startup. Do not add a dependency for this if a few lines of bit arithmetic will do; if you believe a dependency is genuinely required, stop and ask.
> 5. **F5** — make `resetRateLimits` restore the **empty** set, or document at `setTrustedCloudflarePeers` that a reset re-reads config. State which you chose and why in the report.
> 6. **Docs** — update `DEPLOY.md` § 4.1: what to set for a Cloudflare Tunnel, that a bare container address decays when containers are renumbered (prefer the CIDR form), and that the mismatch warning from F3 is how you notice. Add a dated as-built note to `phase-8-environment-and-limits.md` § 8C.
>
> **Out of scope — do not touch:** the email-keyed limiter rewrite, screenshot pruning, admin visibility (`BACKLOG.md` §§ 2, 3, 8). No new config keys beyond what is already there. No new dependencies.
>
> **Gates:**
> ```
> cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration
> docker compose config 2>&1 | grep -c "is not set"     # must stay 0
> ```
> Paste real output. Never report a gate green because the code looks right. Do not run `git`. Emit the Handoff report when all gates are green, and list anything you did differently under *Spec divergences*.
