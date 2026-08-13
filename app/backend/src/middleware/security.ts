import { isIP } from "node:net";
import helmet from "helmet";
import { rateLimit, MemoryStore } from "express-rate-limit";
import type { Request } from "express";
import { config } from "../config";
import { logger } from "../lib/logger";
import {
  emptyTrustedPeerSet,
  isPeerTrusted,
  normalizePeer,
  parseTrustedCloudflarePeers,
} from "../lib/trusted-peers";
import type { TrustedPeerSet } from "../lib/trusted-peers";

export {
  emptyTrustedPeerSet,
  isPeerTrusted,
  normalizePeer,
  parseTrustedCloudflarePeers,
};

// The ONLY module that imports helmet / express-rate-limit (§03 module ownership).

// Stores are constructed explicitly and held here so the test harness can clear
// them between tests exactly as it truncates the database. authLimiter is ONE
// instance mounted on several paths, so all its mount points share a single
// budget (that is intended — see the rate-limit design in app.ts); the shared
// store is the same thing seen from the other side.
const authLimiterStore = new MemoryStore();
const apiLimiterStore = new MemoryStore();
const notificationsTestLimiterStore = new MemoryStore();

/**
 * Clears every in-memory rate-limit store and restores the trusted-peer set to
 * the EMPTY default (the gate OFF). Called by the integration harness's
 * per-test reset alongside resetDatabase(): authLimiter is
 * config.AUTH_RATE_LIMIT /15min per client and the integration project runs
 * single-fork, so a suite that legitimately issues more auth requests than the
 * budget (e.g. password-reset) would starve itself and every later file
 * without a reset. The trusted-peer set is the same kind of shared module
 * state — a test that enables a tunnel peer for one test must not leak it into
 * the rest of the suite, so a reset restores the empty set (NOT a re-read of
 * config) and a test must re-apply its setTrustedCloudflarePeers override
 * after each reset.
 * Deliberately NOT a NODE_ENV==="test" bypass — that would leave the guard
 * unexercised in the one place it is enforced.
 */
export async function resetRateLimits(): Promise<void> {
  await authLimiterStore.resetAll();
  await apiLimiterStore.resetAll();
  await notificationsTestLimiterStore.resetAll();
  trustedCloudflarePeers = emptyTrustedPeerSet();
  warnedPeerMismatch = false;
}

/**
 * The socket peer addresses from which a CF-Connecting-IP header is accepted,
 * derived from the TRUSTED_CLOUDFLARE_PEERS config key (comma-separated IPv4/
 * IPv6 literals and CIDR ranges — parsing lives in lib/trusted-peers.ts, which
 * also refuses a malformed entry at boot).
 * A real Cloudflare Tunnel (client → CF edge → cloudflared → Express) is the
 * ONLY channel on which that header is set by Cloudflare itself, so it is only
 * honoured when the request's immediate peer (req.socket.remoteAddress) is one
 * of these. NO Cloudflare Tunnel exists in any deployment today, so this set is
 * EMPTY and the header is never honoured: every request keys on req.ip (driven
 * by TRUST_PROXY_HOPS). When a real tunnel is deployed, set
 * TRUSTED_CLOUDFLARE_PEERS to the address the backend sees from cloudflared —
 * nothing else.
 *
 * Caddy is deliberately NOT a trusted peer: it forwards a client-supplied
 * CF-Connecting-IP verbatim (verified end-to-end), so listing its container
 * address would re-open the spoofing hole this gate closes. Only a peer that
 * genuinely terminates a Cloudflare tunnel may be added.
 */
let trustedCloudflarePeers: TrustedPeerSet = parseTrustedCloudflarePeers(
  config.TRUSTED_CLOUDFLARE_PEERS,
);

/** Once-only mismatch warn (F3): a CF-Connecting-IP from a peer outside a
 * non-empty trusted set is the signature of F1/F2/F4 — a misconfiguration that
 * would otherwise be silent. Warn once so a hostile client cannot flood the
 * log. */
let warnedPeerMismatch = false;

/**
 * Test seam (mirrors resetRateLimits): replace the trusted-peer set so the
 * trusted-tunnel path can be exercised. A later resetRateLimits() restores the
 * EMPTY set, so a test must re-apply its override after each reset.
 */
export function setTrustedCloudflarePeers(peers: TrustedPeerSet): void {
  trustedCloudflarePeers = peers;
  warnedPeerMismatch = false;
}

/** Size of the trusted-peer set (literals + ranges) for the startup log —
 * never the addresses, which are not secret but are not needed at info. */
export function trustedCloudflarePeerCount(): number {
  return trustedCloudflarePeers.literals.size + trustedCloudflarePeers.cidrs.length;
}

/**
 * The real client address for rate-limit keying.
 *
 * CF-Connecting-IP is trusted — and used as the key — ONLY when BOTH hold:
 *  1. the request's immediate socket peer (req.socket.remoteAddress) is in the
 *     trusted-peer set, AND
 *  2. the header value is a syntactically valid IPv4/IPv6 literal.
 * Every other request keys on Express's req.ip (driven by TRUST_PROXY_HOPS).
 *
 * What an operator must set to enable the trusted-tunnel path: put the address
 * the backend sees from cloudflared into TRUSTED_CLOUDFLARE_PEERS (comma-
 * separated) in .env — the same key is passed through by both compose files.
 * That is the ONLY step; while the key is unset or empty the set is empty, the
 * header is NEVER honoured, and the limiter falls back to req.ip. The gate is
 * off by default because no deployment runs a Cloudflare Tunnel today.
 *
 * Why the peer gate exists: parsing as an IP literal is a validity check, not
 * a trust check. Caddy forwards whatever header a client sent verbatim, so on
 * today's channels a well-formed CF-Connecting-IP is still attacker-controlled
 * — trusting it would let an attacker rotate the header to evade the per-IP
 * budget or claim a victim's address to fill their bucket. The peer gate is
 * what makes the value trustworthy; the literal check only keeps one malformed
 * value from merging every client into a single bucket. (Node's isIP returns
 * 4 or 6 for a valid literal and 0 otherwise.)
 */
export function clientIp(req: Request): string {
  const peer = normalizePeer(req.socket.remoteAddress);
  const gateArmed =
    trustedCloudflarePeers.literals.size + trustedCloudflarePeers.cidrs.length >
    0;
  const peerTrusted =
    gateArmed &&
    peer !== undefined &&
    isPeerTrusted(trustedCloudflarePeers, peer);
  const raw = req.headers["cf-connecting-ip"];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  const headerArrived = value !== undefined && value !== "";
  if (peerTrusted) {
    if (value !== undefined && isIP(value) !== 0) {
      return value;
    }
  } else if (gateArmed && headerArrived && peer !== undefined) {
    // A CF-Connecting-IP arrived from a peer outside a NON-EMPTY trusted set —
    // the exact signature of a misconfigured gate (F1/F2/F4), which would
    // otherwise be silent. Warn once, naming the observed peer. When the set
    // is empty (the normal state) this never fires.
    if (!warnedPeerMismatch) {
      warnedPeerMismatch = true;
      logger.warn(
        { peer },
        "CF-Connecting-IP header arrived from a peer outside TRUSTED_CLOUDFLARE_PEERS — ignoring the header. Fix the config or the header will be ignored.",
      );
    }
  }
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

/**
 * Strict security headers (CSP + HSTS + the helmet defaults like
 * X-Frame-Options / X-Content-Type-Options).
 *
 * `useDefaults: false` so we emit EXACTLY the D10 directive list — notably
 * WITHOUT `upgrade-insecure-requests`, which helmet adds by default and which
 * would break the SPA served over plain HTTP (it upgrades same-origin asset
 * requests to https). In production behind Caddy everything is already https,
 * so its absence is harmless there too.
 *
 * `styleSrc` allows `'unsafe-inline'` because shadcn/Tailwind emit inline
 * styles; `scriptSrc` stays `'self'` only (no inline) — that's the XSS guard.
 */
export const securityHeaders = helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  strictTransportSecurity: {
    maxAge: 31536000,
    includeSubDomains: true,
  },
});

// Both IP-keyed limiters supply a custom keyGenerator (clientIp). This
// deliberately skips express-rate-limit's runtime `ip` / `trustProxy` /
// `xForwardedForHeader` validations — those run only inside the DEFAULT
// keyGenerator (verified in express-rate-limit v7.5's source). Skipping is not
// silencing a real misconfiguration: clientIp validates its own IP source
// (CF-Connecting-IP is honoured only from a trusted Cloudflare peer, else it
// falls back to req.ip, which is safe because TRUST_PROXY_HOPS is a fixed hop
// count and never `true`).

/** Auth endpoints: AUTH_RATE_LIMIT (default 30) requests / 15 minutes per client. */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.AUTH_RATE_LIMIT,
  store: authLimiterStore,
  keyGenerator: (req) => clientIp(req),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again later." },
});

/** Authenticated API endpoints: 120 requests / minute per client. */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  store: apiLimiterStore,
  keyGenerator: (req) => clientIp(req),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down." },
});

/**
 * Per-user limit for POST /notifications/test: 1 / 10s. Keyed by the
 * authenticated user id (NOT the IP) so users behind one NAT are not
 * rate-limited together. v7 option is `keyGenerator`, not `keyFn`.
 */
export const notificationsTestLimiter = rateLimit({
  windowMs: 10_000,
  limit: 1,
  store: notificationsTestLimiterStore,
  keyGenerator: (req) => `notif-test:${req.user?.id ?? "anon"}`,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Please wait a few seconds before testing again." },
});
