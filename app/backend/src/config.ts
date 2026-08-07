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
  return parsed.data;
}

export const config: AppConfig = loadConfig();
