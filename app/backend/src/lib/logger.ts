import { createRequire } from "node:module";
import pino from "pino";
import { config } from "../config";

/**
 * The single application logger.
 *
 * The `redact` list is how the "never log secrets" rule (§03) is enforced
 * mechanically: any object property at one of these paths is replaced with
 * "[Redacted]" before it ever reaches a log line. Add to this list whenever a
 * new secret-bearing field is introduced — never log secrets by hand.
 */

// Use the pretty transport ONLY in dev AND only when pino-pretty is actually
// installed. It's a devDependency, so the prod image (`pnpm install --prod`)
// omits it — resolving it there throws, and we fall back to raw JSON instead
// of crashing at startup.
function prettyTransport(): object {
  if (config.NODE_ENV === "production") return {};
  try {
    createRequire(import.meta.url).resolve("pino-pretty");
    return {
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:HH:MM:ss",
          ignore: "pid,hostname",
        },
      },
    };
  } catch {
    return {};
  }
}

export const logger = pino({
  level: config.NODE_ENV === "production" ? "info" : "debug",
  redact: [
    "req.headers.cookie",
    "password",
    "appPassword",
    "gmailAppPassword",
    "code",
    "otp",
    "sid",
    "telegramBotToken",
    "botToken",
    "RESEND_API_KEY",
    "APP_ENCRYPTION_KEY",
    "SESSION_SECRET",
  ],
  ...prettyTransport(),
});

export type Logger = typeof logger;
