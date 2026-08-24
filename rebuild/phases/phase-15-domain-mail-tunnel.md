# Phase 15 — Domain, mail and tunnel

> 🧑 **This phase is operator-led, not orchestrator-led.** It begins with a card payment and a Cloudflare dashboard, and most of its verification happens in a browser and a DNS zone. An orchestrator should implement the code half (§ 15B) and then **stop and hand over** — it cannot buy a domain, click through Zero Trust, or confirm an email landed in someone's inbox.

**Goal:** make the app reachable at a stable HTTPS hostname and able to send mail, so a second person can actually use it.

**Why this is last in the build queue.** Everything before it improves software you already run. This one changes what the deployment *is* — and it is the prerequisite for phase 16 (admin visibility), which needs a second user, which needs working password reset, which needs this.

**Attach for this session:** `BACKLOG.md` § 12 (the costed decision this phase implements), `DEPLOY.md`, `phases/phase-5-deploy-ops.md` (the VPS-and-Caddy topology this replaces), `phases/phase-8-environment-and-limits.md` § 8C (the trusted-peer gate this finally arms), `reference/supply-chain-and-ci.md`.

> 📡 **Fetch live docs (Context7):** `cloudflared` (named tunnels, running as a container, ingress config), Resend (domain verification, SPF/DKIM records), Docker Compose. **Do not write any of this from memory** — Cloudflare's Zero Trust UI and Resend's onboarding both change.

---

## 15A — The purchases and the dashboards `[manual]`

**Decided already in `BACKLOG.md` § 12 — do not re-litigate:**

- **A `.com`, ~$10.46/yr (≈₱641).** Not the cheapest sticker price. `.uk` is $5.30 and `.us` is $6.50, but **`.us` requires a US nexus** the operator does not have, and cheap new gTLDs (`.xyz`, `.work`, `.icu`) carry poor sending reputation — which matters because **the domain's main job is email that lands in an inbox**. `.com` is also cheaper than `.org` on renewal ($10.46 vs $11.20).
- **Cloudflare Registrar**, sold at cost, so the domain lands on Cloudflare DNS automatically.
- **A named tunnel, not a quick tunnel.** `cloudflared tunnel --url` is free and domain-less but issues a **random `*.trycloudflare.com` hostname that changes on every restart** — which breaks `APP_URL` and every reset link already sent.

**Steps:**
1. Register the domain in Cloudflare.
2. **Resend:** add the domain, copy the SPF/DKIM records it gives into Cloudflare DNS, verify, create an API key. `MAIL_FROM` must be at that domain — `onboarding@resend.dev` only delivers to your own Resend account address and **cannot reach colleagues**.
3. **Cloudflare Zero Trust → Networks → Tunnels:** create a tunnel, note its token, add a public hostname `sprout.<domain>` routing to `http://backend:3000`.

## 15B — The code half

**Contract:**
- **`cloudflared` as a service in `docker-compose.yml`**, on `sprout-net`, so the tunnel starts and stops with the stack rather than being a separate thing to remember. Its token is a secret: it goes in `.env` and reaches the container via `${KEY}` passthrough like everything else (phase 8 § 8A). **Never commit it** — the gitleaks hook is the backstop, not the plan.
- **`APP_URL=https://sprout.<domain>` and `NODE_ENV=production`.** The `APP_URL` production guard added in phase 5 refuses to boot on a localhost value, so this is the first time production mode is actually usable.
- **Arm the trusted-peer gate.** Phase 8 § 8C built `TRUSTED_CLOUDFLARE_PEERS` and left it **empty by default**, meaning `CF-Connecting-IP` is never honoured and every request keys on the tunnel's address. **Left unset behind a tunnel, the auth rate limit becomes one global budget for everyone** — worse than the NAT problem it was built to fix. Set it to the address the backend sees from `cloudflared`, or the compose network in CIDR form.
  - ⚠️ **A bare container address decays.** Docker reassigns bridge addresses on recreate, and this project recreates containers constantly. Prefer the CIDR form (e.g. `172.20.0.0/16`) and know that it trusts any container on that network to set the header — acceptable when the network holds only your own services. Phase 8's mismatch warning is the safety net; watch for it.
  - `/0` prefixes and host-bits-set entries **refuse to boot** by design.
- **Rewrite `DEPLOY.md` around a tunnel.** It currently documents only a VPS behind Caddy. In this topology **Cloudflare terminates TLS and Caddy is not used at all** — so a reader following the current runbook on Windows gets instructions for a topology that no longer exists. **Keep `docker-compose.prod.yml` and `Caddyfile`**: they stay correct if a VPS ever happens, and deleting them would throw away proven work.
- No new backend dependency. Nothing here should touch application logic.

**Gate 15B:**
```
docker compose config > /dev/null && docker compose config 2>&1 | grep -c "is not set"   # must be 0
cd app/backend && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration
git grep -nE "eyJ|cloudflared.*token" -- . ':!*.md'    # no token in the tree
```

---

## Verification Gate

Almost all of this is `[manual]` by nature — it is a deployment, not a feature.

| # | Check | Pass looks like |
|---|---|---|
| 1 | `https://sprout.<domain>/health` from a phone on mobile data | 200 with a **real** certificate — no `-k`, no warning |
| 2 | `docker compose ps` | `cloudflared` up alongside backend and postgres; backend still not publishing 3000 publicly |
| 3 | Trigger a password reset for your own account | The email **arrives in the inbox**, not spam, and the link points at `sprout.<domain>` — not localhost |
| 4 | Check the boot log after setting `TRUSTED_CLOUDFLARE_PEERS` | The trusted-peer count is **1** (or the CIDR), not 0 |
| 5 | **Two different devices on different networks each fail login repeatedly** | They hit **separate** rate-limit budgets. This is phase 8 § 8C's outstanding `[manual]` and the only proof the gate does what it was built for |
| 6 | Forge `CF-Connecting-IP` from a direct connection to the container | Still ignored — arming the gate must not have opened the spoofing hole |
| 7 | Restart the whole stack, re-check 1 and 4 | Hostname unchanged; the peer value still matches after container recreation |
| 8 | Invite one colleague; they sign up, set credentials, run one manual clock-in | End to end on a real account that is not yours |

**Row 5 also closes phase 8's tag.** Row 7 is the one that catches the decaying-address trap.

Commit per the loop in `AGENTS.md` for § 15B. Tag `phase-15-complete` when the table is filled in — and **then go back and tag `phase-8-complete`**, which has been waiting on row 5.
