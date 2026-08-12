import { isIP } from "node:net";
import helmet from "helmet";
import { rateLimit, MemoryStore } from "express-rate-limit";
import type { Request } from "express";
import { config } from "../config";

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
 * its empty default. Called by the integration harness's per-test reset
 * alongside resetDatabase(): authLimiter is config.AUTH_RATE_LIMIT /15min per
 * client and the integration project runs single-fork, so a suite that
 * legitimately issues more auth requests than the budget (e.g. password-reset)
 * would starve itself and every later file without a reset. The trusted-peer
 * set is the same kind of shared module state — a test that enables a tunnel
 * peer for one test must not leak it into the rest of the suite.
 * Deliberately NOT a NODE_ENV==="test" bypass — that would leave the guard
 * unexercised in the one place it is enforced.
 */
export async function resetRateLimits(): Promise<void> {
  await authLimiterStore.resetAll();
  await apiLimiterStore.resetAll();
  await notificationsTestLimiterStore.resetAll();
  trustedCloudflarePeers = new Set();
}

/**
 * The socket peer addresses from which a CF-Connecting-IP header is accepted.
 * A real Cloudflare Tunnel (client → CF edge → cloudflared → Express) is the
 * ONLY channel on which that header is set by Cloudflare itself, so it is only
 * honoured when the request's immediate peer (req.socket.remoteAddress) is one
 * of these. NO Cloudflare Tunnel exists in any deployment today, so this set is
 * EMPTY and the header is never honoured: every request keys on req.ip (driven
 * by TRUST_PROXY_HOPS). When a real tunnel is deployed, add the address the
 * backend sees from cloudflared here — nothing else.
 *
 * Caddy is deliberately NOT a trusted peer: it forwards a client-supplied
 * CF-Connecting-IP verbatim (verified end-to-end), so listing its container
 * address would re-open the spoofing hole this gate closes. Only a peer that
 * genuinely terminates a Cloudflare tunnel may be added.
 */
let trustedCloudflarePeers: ReadonlySet<string> = new Set();

/**
 * Test seam (mirrors resetRateLimits): replace the trusted-peer set so the
 * trusted-tunnel path can be exercised, and restore the empty default
 * afterwards. Production never calls this — there is no tunnel to trust.
 */
export function setTrustedCloudflarePeers(peers: ReadonlySet<string>): void {
  trustedCloudflarePeers = peers;
}

/** Strips the IPv4-mapped IPv6 prefix so a dual-stack peer ("::ffff:127.0.0.1")
 * matches the plain form in trustedCloudflarePeers. */
function normalizePeer(peer: string | undefined): string | undefined {
  return peer?.startsWith("::ffff:") ? peer.slice("::ffff:".length) : peer;
}

/**
 * The real client address for rate-limit keying. CF-Connecting-IP is honoured
 * ONLY when the request actually arrived from a trusted Cloudflare channel —
 * the socket peer is in trustedCloudflarePeers — AND the value is a
 * syntactically valid IPv4/IPv6 literal. Every other request keys on Express's
 * req.ip (driven by TRUST_PROXY_HOPS).
 *
 * Parsing as an IP literal is a validity check, not a trust check: Caddy
 * forwards whatever header a client sent verbatim, so on today's channels a
 * well-formed CF-Connecting-IP is still attacker-controlled — it would let an
 * attacker rotate the header to evade the per-IP budget or claim a victim's
 * address to fill their bucket. The peer gate is what makes the value
 * trustworthy; the literal check only keeps one malformed value from merging
 * every client into a single bucket. (Node's isIP returns 4 or 6 for a valid
 * literal and 0 otherwise.)
 */
export function clientIp(req: Request): string {
  const peer = normalizePeer(req.socket.remoteAddress);
  if (peer !== undefined && trustedCloudflarePeers.has(peer)) {
    const raw = req.headers["cf-connecting-ip"];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (value !== undefined && isIP(value) !== 0) {
      return value;
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
