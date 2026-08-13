import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import {
  getRun,
  isRunWaitingForOtp,
  listRuns,
  startRun,
  submitRunOtp,
} from "../services/runs";
import { runQueue } from "../services/run-queue";
import type { Run } from "../db/schema";

export const runsRouter = Router();
runsRouter.use(requireAuth);

const startSchema = z.object({ action: z.enum(["in", "out"]) }).strict();
const otpSchema = z.object({ code: z.string().regex(/^\d{4,6}$/) }).strict();
// Query params are strings; coerce to int. Out-of-range or non-numeric is a 400
// — never a silent clamp, which would lie about what was returned (phase 9A).
const listQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(10) })
  .strict();

function publicRun(run: Run) {
  return {
    id: run.id,
    action: run.action,
    status: run.status,
    loginMethod: run.loginMethod,
    error: run.error,
    steps: run.steps ?? [],
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
    waitingForOtp: run.status === "running" && isRunWaitingForOtp(run.id),
  };
}

runsRouter.post("/", async (req: Request, res: Response) => {
  const parsed = startSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const result = await startRun({ userId: req.user!.id, action: parsed.data.action });
  if (!result.ok) {
    if (result.reason === "no_credentials") {
      res.status(400).json({
        error: "No Sprout credentials saved. Add your Sprout username and password first.",
      });
      return;
    }
    res.status(409).json({ error: "A run is already in progress" });
    return;
  }
  res.status(202).json({ run: publicRun(result.run) });
});

runsRouter.get("/", async (req: Request, res: Response) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const { runs, hasMore } = await listRuns(req.user!.id, parsed.data.limit);
  res.json({ runs: runs.map(publicRun), hasMore });
});

// Must be registered before "/:id" so "queue" is not captured as an id.
runsRouter.get("/queue/stats", (_req: Request, res: Response) => {
  res.json(runQueue.stats());
});

runsRouter.get("/:id", async (req: Request, res: Response) => {
  const id = req.params["id"];
  if (typeof id !== "string") {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  const run = await getRun(req.user!.id, id);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  res.json({ run: publicRun(run) });
});

runsRouter.post("/:id/otp", async (req: Request, res: Response) => {
  const parsed = otpSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const id = req.params["id"];
  if (typeof id !== "string") {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  const run = await getRun(req.user!.id, id);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  if (!isRunWaitingForOtp(run.id)) {
    res.status(400).json({ error: "Run is not currently waiting for an OTP" });
    return;
  }
  const accepted = submitRunOtp(run.id, parsed.data.code);
  if (!accepted) {
    res.status(400).json({ error: "OTP could not be accepted" });
    return;
  }
  res.json({ ok: true });
});
