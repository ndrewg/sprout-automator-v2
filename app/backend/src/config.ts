import { z } from "zod";
import { parseSignupAllowlist } from "./lib/signup-allowlist";
import { parseTrustedCloudflarePeers } from "./lib/trusted-peers";

// Compose passes every ${KEY} through as the empty string when the variable is
// unset, while a native (tsx --env-file) run leaves it undefined. Both must
// mean "absent" so an unset key behaves identically inside and outside Docker
// and the defaults below stay the single source of truth. The default has to
// sit INSIDE the preprocess: zod's `.default()` only fires on `undefined`, so
// the "" -> undefined conversion must happen before the inner schema (which
// carries the default) runs.
const emptyToUndefined = (value: unknown): unknown =>
  value === "" ? undefined : value;

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  APP_ENCRYPTION_KEY: z
    .string()
    .min(64, "APP_ENCRYPTION_KEY must be a 32-byte hex string (64 chars)")
    .max(64),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be >=32 chars"),
  DATA_DIR: z.string().default("./data"),
  SPROUT_URL: z.string().url().default("https://kmcsolutions.hrhub.ph/"),
  MAX_CONCURRENT_RUNS: z
    .preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(1).max(20).default(3),
    ),
  MISSED_RUN_GRACE_MINUTES: z
    .preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(1).max(180).default(20),
    ),
  // Signup gating (§4A.2): comma-separated list of allowed addresses/domains.
  // Optional outside production (unset = open signup, logged as a warning at
  // startup); REQUIRED in production — see the check in loadConfig.
  SIGNUP_ALLOWED: z.string().optional(),
  // Public base URL for emailed links (password reset, later verify). Dev
  // default is the local backend, which serves the built SPA in the production
  // image; set APP_URL to the real origin in production.
  APP_URL: z
    .preprocess(
      emptyToUndefined,
      z.string().url().default("http://localhost:3000"),
    ),
  // Email (§4B.1): both optional. When either is unset, mailer.ts logs the
  // email (recipient + subject only) instead of sending, so dev needs no
  // provider and no reset token ever reaches a log file.
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().optional(),
  // Auth rate-limit budget: requests per 15 min per client IP, shared across
  // login, signup, forgot-password and reset (one authLimiter instance).
  // Configurable so a deploy that legitimately exceeds the budget — e.g. a
  // team behind one NAT — can raise it without a code change, and so the e2e
  // suite (which exercises flows, not limits) can set its own headroom. The
  // budget-is-enforced property is asserted by the integration suite at the
  // default (30 as of phase 8 §8B; the test derives its loop bound from this
  // value so a future change does not break it again).
  AUTH_RATE_LIMIT: z
    .preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(1).max(1000).default(30),
    ),
  // Number of trusted reverse-proxy hops between the client and Express
  // (app.set("trust proxy", …)). Default 1 — a single reverse proxy, which is
  // today's behaviour. 0 disables proxy trust (the socket address is the
  // client). Behind a Cloudflare Tunnel chain (client → CF edge → cloudflared
  // → Express) keep it at 1: the rate limiters key on CF-Connecting-IP — but
  // ONLY when the request actually arrived from a trusted Cloudflare peer
  // (see middleware/security.ts; no tunnel exists in any deployment today, so
  // they key on req.ip) — instead of raising it, since the true client is not
  // at a predictable X-Forwarded-For position there.
  TRUST_PROXY_HOPS: z
    .preprocess(emptyToUndefined, z.coerce.number().int().min(0).default(1)),
  // Comma-separated socket peer addresses from which a CF-Connecting-IP header
  // is accepted as the real client address (see middleware/security.ts —
  // clientIp). EMPTY by default and OPT-IN only: no deployment runs a
  // Cloudflare Tunnel today, so the rate limiters key on req.ip and a
  // client-supplied header is ignored no matter how well-formed it is. When a
  // real tunnel is put in front (BACKLOG.md § 12), set this to the address the
  // backend sees from cloudflared — nothing else. Entries are IPv4/IPv6
  // literals or CIDR ranges (e.g. 172.20.0.0/16 — prefer the CIDR form: a bare
  // container address decays when Docker renumbers the network). Each entry is
  // validated at boot (see loadConfig) — a malformed one refuses to start.
  // Caddy's address must never be listed: it forwards a client-supplied header
  // verbatim.
  TRUSTED_CLOUDFLARE_PEERS: z
    .preprocess(emptyToUndefined, z.string().optional()),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  // The same "refuse to start on a bad environment" stance as the Zod schema:
  // a production deployment with no allowlist is an open signup on a tool that
  // stores colleagues' HRHub credentials — fail at boot, not at first signup.
  if (
    parsed.data.NODE_ENV === "production" &&
    parseSignupAllowlist(parsed.data.SIGNUP_ALLOWED).length === 0
  ) {
    throw new Error(
      "Invalid environment configuration:\n" +
        "  - SIGNUP_ALLOWED: required when NODE_ENV=production — set a " +
        "comma-separated list of allowed email addresses and domains",
    );
  }
  // 5.4b: the same refuse-to-start stance for APP_URL. The default is
  // http://localhost:3000 — correct locally, but a SILENT failure in
  // production: the app boots and everything appears to work while every
  // password-reset and email-verification link points at localhost. Nothing
  // warns, because a default exists. Fail at boot instead, naming the fix.
  if (parsed.data.NODE_ENV === "production") {
    const appUrlHost = new URL(parsed.data.APP_URL).hostname;
    if (appUrlHost === "localhost" || appUrlHost === "127.0.0.1") {
      throw new Error(
        "Invalid environment configuration:\n" +
          "  - APP_URL: host must not be localhost or 127.0.0.1 when " +
          "NODE_ENV=production — set APP_URL to the public origin " +
          "(e.g. https://sprout.yourdomain.com), or every password-reset and " +
          "email-verification link points at the wrong host",
      );
    }
  }
  // TRUSTED_CLOUDFLARE_PEERS (§8C hardening): the same "refuse to start on a
  // bad security-relevant value" stance as SIGNUP_ALLOWED. A typo (stray quote,
  // "cloudflared", "172.20..4") would otherwise produce a non-empty set that
  // matches nothing — the gate reports as configured and behaves as off, the
  // exact §8C failure reached by misconfiguration. Fail at boot instead,
  // naming the offending position.
  try {
    parseTrustedCloudflarePeers(parsed.data.TRUSTED_CLOUDFLARE_PEERS);
  } catch (err) {
    throw new Error(
      "Invalid environment configuration:\n" +
        `  - TRUSTED_CLOUDFLARE_PEERS: ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
  }
  return parsed.data;
}

export const config: AppConfig = loadConfig();
