import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { pinoHttp } from "pino-http";
import cookieParser from "cookie-parser";
import { sql } from "drizzle-orm";
import { config } from "./config";
import { logger } from "./lib/logger";
import { db } from "./db/client";
import { attachUser } from "./middleware/auth";
import { securityHeaders, authLimiter, apiLimiter } from "./middleware/security";
import { authRouter } from "./routes/auth";
import { credentialsRouter } from "./routes/credentials";
import { runsRouter } from "./routes/runs";
import { scheduleRouter } from "./routes/schedule";
import { notificationsRouter } from "./routes/notifications";
import { runQueue } from "./services/run-queue";
import {
  activeScheduleCount,
  enabledScheduleCount,
  schedulerLastFireAt,
} from "./services/scheduler";

// Everything that builds the Express app: middleware order, routers, /health,
// the static SPA, the SPA catch-all, and the global error handler. Split out of
// index.ts so route tests can import it WITHOUT booting a listener, recovering
// orphaned runs, or loading cron schedules (all of which live in index.ts's
// start()). This is a move, not a redesign — the middleware order is verbatim.

export const app = express();

// Behind a reverse proxy in production (Caddy, Phase 5). The hop count is
// configurable via TRUST_PROXY_HOPS (default 1 = today's behaviour; 0 disables
// proxy trust). Behind a Cloudflare Tunnel chain — client → CF edge →
// cloudflared → Express — leave it at 1 and let the rate limiters key on
// CF-Connecting-IP (only from a trusted Cloudflare peer — see
// middleware/security.ts; none exists today, so they key on req.ip) instead
// of raising it, since the true client is not at a predictable X-Forwarded-For
// position there.
app.set("trust proxy", config.TRUST_PROXY_HOPS);

// Strict security headers (CSP, HSTS, X-Frame-Options, …) on every response.
app.use(securityHeaders);

// Request logging with a per-request id. Secrets are redacted by the logger's
// `redact` list (see lib/logger.ts).
app.use(
  pinoHttp({
    logger,
    genReqId: (req, res) => {
      const existing = req.headers["x-request-id"];
      const id =
        (Array.isArray(existing) ? existing[0] : existing) ?? randomUUID();
      res.setHeader("x-request-id", id);
      return id;
    },
    // Don't log the high-frequency frontend polls (they drown out real
    // activity like run progress). POST /runs, GET /runs/:id, etc. still log.
    autoLogging: {
      ignore: (req) => {
        if (req.method !== "GET") return false;
        const url = (req.url ?? "").split("?")[0];
        return url === "/runs" || url === "/health";
      },
    },
  }),
);

app.use(express.json({ limit: "100kb" }));
app.use(cookieParser(config.SESSION_SECRET));
app.use(attachUser);

// Rate limits (before the routers). Auth endpoints are strict; the
// authenticated API is generous. /health is intentionally left unthrottled.
app.use("/auth/login", authLimiter);
app.use("/auth/signup", authLimiter);
// Both reset endpoints are unauthenticated and belong to the same family as
// login: /auth/forgot-password sends email (so it is a mailbox-flooding and
// account-probing surface) and /auth/reset-password takes an unauthenticated
// token. authLimiter is one instance, so all four mount points share a budget.
app.use("/auth/forgot-password", authLimiter);
app.use("/auth/reset-password", authLimiter);
// 4B.2 — the verify path is the same family: GET/POST /auth/verify redeem an
// unauthenticated token, and /auth/verify/resend sends email. One mount covers
// all three via prefix matching, all sharing the authLimiter budget.
app.use("/auth/verify", authLimiter);
app.use("/credentials", apiLimiter);
app.use("/schedule", apiLimiter);
app.use("/runs", apiLimiter);
app.use("/notifications", apiLimiter);

app.use("/auth", authRouter);
app.use("/credentials", credentialsRouter);
app.use("/runs", runsRouter);
app.use("/schedule", scheduleRouter);
app.use("/notifications", notificationsRouter);

// /health is intentionally unauthenticated and unthrottled (see the rate-limit
// comment above): an uptime monitor must be able to probe it without a session
// or a budget. It must also leak nothing — no emails, no per-user counts, no
// values derived from a secret. `status` is DERIVED, never literal: it is
// "ok" only when every check passes, otherwise "degraded", and a failing check
// responds 503 (not 200) so a monitor can key off the status code alone.
//
// The checks (12A):
//   - db: can we run a trivial query? A down DB is the historical "healthy"
//     lie — a backend whose only honest field said "down" still answered 200.
//   - scheduler: does the number of cron schedules REGISTERED in this process
//     match the number of ENABLED schedules in the database? A backend that
//     booted but registered zero schedules (and so will never run again) is
//     broken, and today nothing reports it.
//   - queue: the run-queue depth, so a wedged queue is visible.
app.get("/health", async (_req: Request, res: Response) => {
  let dbStatus: "ok" | "down" = "down";
  let enabledInDb = 0;
  try {
    await db.execute(sql`select 1`);
    dbStatus = "ok";
    enabledInDb = await enabledScheduleCount();
  } catch (err: unknown) {
    logger.error({ err }, "health DB check failed");
  }

  const registered = activeScheduleCount();
  // enabledInDb > 0 but nothing registered means the process never rehydrated
  // its cron schedules — it is alive but will never run. That is degraded.
  const scheduleMismatch = enabledInDb > 0 && registered === 0;
  const registeredMatchesEnabled = enabledInDb === 0 || registered === enabledInDb;
  const { active, waiting, cap } = runQueue.stats();

  const degraded = dbStatus === "down" || scheduleMismatch;
  res.status(degraded ? 503 : 200).json({
    status: degraded ? "degraded" : "ok",
    service: "sprout-automator-backend",
    version: "0.0.0",
    db: dbStatus,
    scheduler: {
      registered,
      enabledInDb,
      registeredMatchesEnabled,
      lastFireAt: schedulerLastFireAt(),
    },
    queue: { active, waiting, cap },
    timestamp: new Date().toISOString(),
  });
});

// Serve the built SPA (production). In dev this dir won't exist (Vite serves
// the frontend); in the Docker image the frontend build stage lands here.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../public");
app.use(express.static(publicDir));

// SPA catch-all: any GET NOT under an API prefix serves index.html so client
// routing works while the API stays reachable. Regex negative-lookahead
// (Express 5 routing — not a "*" string).
app.get(
  /^\/(?!auth|credentials|schedule|runs|health|notifications)(?:.*)$/,
  (_req: Request, res: Response) => {
    res.sendFile(path.join(publicDir, "index.html"));
  },
);

// Global error handler (backstop). Logs the error, responds with a generic
// JSON 500, and never leaks a stack trace to the client.
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  req.log.error({ err }, "unhandled error");
  res.status(500).json({ error: "Internal server error" });
});
