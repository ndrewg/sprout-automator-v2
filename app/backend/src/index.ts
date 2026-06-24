import { randomUUID } from "node:crypto";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { pinoHttp } from "pino-http";
import { sql } from "drizzle-orm";
import { config } from "./config";
import { logger } from "./lib/logger";
import { db } from "./db/client";

const app = express();

// Behind a reverse proxy in production (Caddy, Phase 5).
app.set("trust proxy", 1);

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
  }),
);

app.use(express.json({ limit: "100kb" }));

app.get("/health", async (_req: Request, res: Response) => {
  let dbStatus: "ok" | "down" = "down";
  try {
    await db.execute(sql`select 1`);
    dbStatus = "ok";
  } catch (err: unknown) {
    logger.error({ err }, "health DB check failed");
  }
  res.json({
    status: "ok",
    service: "sprout-automator-backend",
    version: "0.0.0",
    db: dbStatus,
    timestamp: new Date().toISOString(),
  });
});

// Global error handler (backstop). Logs the error, responds with a generic
// JSON 500, and never leaks a stack trace to the client.
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  req.log.error({ err }, "unhandled error");
  res.status(500).json({ error: "Internal server error" });
});

app.listen(config.PORT, "0.0.0.0", () => {
  logger.info(
    { port: config.PORT, env: config.NODE_ENV },
    "sprout-automator-backend listening",
  );
});
