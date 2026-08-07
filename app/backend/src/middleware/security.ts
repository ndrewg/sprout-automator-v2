import helmet from "helmet";
import { rateLimit } from "express-rate-limit";

// The ONLY module that imports helmet / express-rate-limit (§03 module ownership).

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

/** Auth endpoints: 10 requests / 15 minutes per IP. */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again later." },
});

/** Authenticated API endpoints: 120 requests / minute per IP. */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
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
  keyGenerator: (req) => `notif-test:${req.user?.id ?? "anon"}`,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Please wait a few seconds before testing again." },
});
