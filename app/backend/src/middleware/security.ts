import helmet from "helmet";
import { rateLimit, MemoryStore } from "express-rate-limit";
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
 * Clears every in-memory rate-limit store. Called by the integration harness's
 * per-test reset alongside resetDatabase(): authLimiter is 10/15min per IP and
 * the integration project runs single-fork, so a suite that legitimately issues
 * more than ten auth requests (e.g. password-reset) would starve itself and
 * every later file without a reset. Deliberately NOT a NODE_ENV==="test" bypass
 * — that would leave the guard unexercised in the one place it is enforced.
 */
export async function resetRateLimits(): Promise<void> {
  await authLimiterStore.resetAll();
  await apiLimiterStore.resetAll();
  await notificationsTestLimiterStore.resetAll();
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

/** Auth endpoints: AUTH_RATE_LIMIT (default 10) requests / 15 minutes per IP. */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.AUTH_RATE_LIMIT,
  store: authLimiterStore,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again later." },
});

/** Authenticated API endpoints: 120 requests / minute per IP. */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  store: apiLimiterStore,
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
