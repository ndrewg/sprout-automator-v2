import { Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client";
import { schedules, type Schedule } from "../db/schema";
import { requireAuth } from "../middleware/auth";
import { recordAudit } from "../lib/audit";
import { registerSchedule, unregisterSchedule } from "../services/scheduler";
import {
  isPausedOn,
  isPhilippineHoliday,
  manilaDateString,
} from "../lib/ph-holidays";

export const scheduleRouter = Router();
scheduleRouter.use(requireAuth);

const DEFAULT_IN = "05:30:00";
const DEFAULT_OUT = "18:05:00";
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type ScheduleView = {
  clockInTime: string;
  clockOutTime: string;
  enabled: boolean;
  updatedAt: string | null;
  configured: boolean;
  pausedFrom: string | null;
  pausedUntil: string | null;
  pausedToday: boolean;
  today: { date: string; holiday: string | null };
};

function todayInfo(): { date: string; holiday: string | null } {
  const now = new Date();
  return { date: manilaDateString(now), holiday: isPhilippineHoliday(now) };
}

function toView(row: Schedule | undefined): ScheduleView {
  if (!row) {
    return {
      clockInTime: DEFAULT_IN,
      clockOutTime: DEFAULT_OUT,
      enabled: false,
      updatedAt: null,
      configured: false,
      pausedFrom: null,
      pausedUntil: null,
      pausedToday: false,
      today: todayInfo(),
    };
  }
  return {
    clockInTime: row.clockInTime,
    clockOutTime: row.clockOutTime,
    enabled: row.enabled,
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
    configured: true,
    pausedFrom: row.pausedFrom,
    pausedUntil: row.pausedUntil,
    pausedToday: isPausedOn(row),
    today: todayInfo(),
  };
}

const timeField = z.string().regex(TIME_RE, "Time must be HH:MM or HH:MM:SS");
const dateField = z
  .string()
  .regex(DATE_RE, "Date must be YYYY-MM-DD")
  .nullable();
const putSchema = z
  .object({
    clockInTime: timeField.optional(),
    clockOutTime: timeField.optional(),
    enabled: z.boolean().optional(),
    pausedFrom: dateField.optional(),
    pausedUntil: dateField.optional(),
  })
  .strict();

function normalizeTime(t: string): string {
  return t.length === 5 ? `${t}:00` : t;
}

scheduleRouter.get("/", async (req: Request, res: Response) => {
  const [row] = await db
    .select()
    .from(schedules)
    .where(eq(schedules.userId, req.user!.id))
    .limit(1);
  res.json({ schedule: toView(row) });
});

scheduleRouter.put("/", async (req: Request, res: Response) => {
  const parsed = putSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const data = parsed.data;

  const setObj: Partial<typeof schedules.$inferInsert> = {};
  const changed: string[] = [];
  if (data.clockInTime !== undefined) {
    setObj.clockInTime = normalizeTime(data.clockInTime);
    changed.push("clockInTime");
  }
  if (data.clockOutTime !== undefined) {
    setObj.clockOutTime = normalizeTime(data.clockOutTime);
    changed.push("clockOutTime");
  }
  if (data.enabled !== undefined) {
    setObj.enabled = data.enabled;
    changed.push("enabled");
  }
  // Pause window: both fields are always sent or cleared together. A window is
  // a closed, inclusive range and must not be allowed to already be over.
  const fromPresent = data.pausedFrom !== undefined;
  const untilPresent = data.pausedUntil !== undefined;
  if (fromPresent !== untilPresent) {
    res.status(400).json({
      error: "Provide both pausedFrom and pausedUntil, or neither.",
    });
    return;
  }
  if (fromPresent && untilPresent) {
    const from = data.pausedFrom;
    const until = data.pausedUntil;
    if (from === undefined || until === undefined) {
      throw new Error("unreachable: paused pair partially present");
    }
    if (from === null && until === null) {
      // Both null → clear the pause window.
      setObj.pausedFrom = null;
      setObj.pausedUntil = null;
      changed.push("pausedFrom", "pausedUntil");
    } else if (from === null || until === null) {
      // Both present but one is null → not a valid pair, not a valid clear.
      res.status(400).json({
        error: "Provide both pausedFrom and pausedUntil, or neither.",
      });
      return;
    } else {
      if (until < from) {
        res.status(400).json({ error: "pausedUntil must be on or after pausedFrom" });
        return;
      }
      if (until < manilaDateString(new Date())) {
        res.status(400).json({ error: "That pause window has already ended." });
        return;
      }
      setObj.pausedFrom = from;
      setObj.pausedUntil = until;
      changed.push("pausedFrom", "pausedUntil");
    }
  }
  if (changed.length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  const userId = req.user!.id;
  const [existing] = await db
    .select()
    .from(schedules)
    .where(eq(schedules.userId, userId))
    .limit(1);

  let row: Schedule | undefined;
  if (existing) {
    [row] = await db
      .update(schedules)
      .set({ ...setObj, updatedAt: new Date() })
      .where(eq(schedules.userId, userId))
      .returning();
  } else {
    // Lazy opt-in: a brand-new row must NOT auto-enable unless the caller said
    // so (the column default is true, so set it explicitly on first insert).
    if (data.enabled === undefined) {
      setObj.enabled = false;
    }
    [row] = await db.insert(schedules).values({ userId, ...setObj }).returning();
  }
  if (!row) throw new Error("schedule upsert returned no row");

  // Atomically (un)register the user's cron tasks to match the new state.
  if (row.enabled) {
    registerSchedule(row);
  } else {
    unregisterSchedule(userId);
  }

  const metadata: Record<string, unknown> = { fields: changed };
  // The pause values are Manila dates, not secrets — record them so a later
  // audit read can answer "when did this user pause and until when".
  if (changed.includes("pausedFrom")) {
    metadata["pausedFrom"] = data.pausedFrom;
    metadata["pausedUntil"] = data.pausedUntil;
  }

  await recordAudit("schedule_updated", {
    userId,
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
    metadata,
  });
  res.json({ schedule: toView(row) });
});
