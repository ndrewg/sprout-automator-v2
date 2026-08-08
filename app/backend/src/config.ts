import { z } from "zod";
import { parseSignupAllowlist } from "./lib/signup-allowlist";

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
  MAX_CONCURRENT_RUNS: z.coerce.number().int().min(1).max(20).default(3),
  MISSED_RUN_GRACE_MINUTES: z.coerce.number().int().min(1).max(180).default(20),
  // Signup gating (§4A.2): comma-separated list of allowed addresses/domains.
  // Optional outside production (unset = open signup, logged as a warning at
  // startup); REQUIRED in production — see the check in loadConfig.
  SIGNUP_ALLOWED: z.string().optional(),
  // Public base URL for emailed links (password reset, later verify). Dev
  // default is the local backend, which serves the built SPA in the production
  // image; set APP_URL to the real origin in production.
  APP_URL: z.string().url().default("http://localhost:3000"),
  // Email (§4B.1): both optional. When either is unset, mailer.ts logs the
  // email (recipient + subject only) instead of sending, so dev needs no
  // provider and no reset token ever reaches a log file.
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().optional(),
  // Auth rate-limit budget: requests per 15 min per IP, shared across login,
  // signup, forgot-password and reset (one authLimiter instance). Configurable
  // so a deploy that legitimately exceeds 10 — e.g. a team behind one NAT — can
  // raise it without a code change, and so the e2e suite (which exercises
  // flows, not limits) can set its own headroom. The 11th-is-429 property is
  // asserted by the integration suite at the default.
  AUTH_RATE_LIMIT: z.coerce.number().int().min(1).max(1000).default(10),
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
  return parsed.data;
}

export const config: AppConfig = loadConfig();
