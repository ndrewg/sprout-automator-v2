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
    "APP_ENCRYPTION_KEY",
    "SESSION_SECRET",
  ],
  // Human-readable, colorized logs in dev; raw JSON in prod (for aggregation).
  // Redaction is applied before the transport, so secrets stay redacted either way.
  ...(config.NODE_ENV === "production"
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:HH:MM:ss",
            ignore: "pid,hostname",
          },
        },
      }),
});

export type Logger = typeof logger;
