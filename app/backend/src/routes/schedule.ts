import { Router, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client";
import { schedules, dayOverrides, type Schedule } from "../db/schema";
import { requireAuth } from "../middleware/auth";
import { recordAudit } from "../lib/audit";
import { registerSchedule, unregisterSchedule } from "../services/scheduler";
import { cancelPendingRetriesForDay } from "../services/run-lifecycle";
import {
  decideDay,
  decideRange,
  isPausedOn,
  manilaDateString,
  manilaNoon,
} from "../services/workday";
import type { DayDecision, WorkdayReason } from "../services/workday";

export const scheduleRouter = Router();
scheduleRouter.use(requireAuth);

const DEFAULT_IN = "05:30:00";
const DEFAULT_OUT = "18:05:00";
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type TodayView = {
  date: string;
  /** The Workday gate's answer for today, and why (phase 16A). */
  work: boolean;
  reason: WorkdayReason;
  /** The holiday name when today is a holiday, else null (the panel's banner). */
  holiday: string | null;
};

type ScheduleView = {
  clockInTime: string;
  clockOutTime: string;
  enabled: boolean;
  updatedAt: string | null;
  configured: boolean;
  pausedFrom: string | null;
  pausedUntil: string | null;
  pausedToday: boolean;
  today: TodayView;
};

async function todayInfo(userId: string): Promise<TodayView> {
  const now = new Date();
  const date = manilaDateString(now);
  const decision = await decideDay({ userId, manilaDate: date, now });
  return {
    date,
    work: decision.work,
    reason: decision.reason,
    // The gate owns the holiday answer now; the panel's banner reads this name.
    holiday:
      decision.reason.code === "holiday"
        ? (decision.reason.holidayName ?? null)
        : null,
  };
}

async function toView(
  userId: string,
  row: Schedule | undefined,
): Promise<ScheduleView> {
  const today = await todayInfo(userId);
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
      today,
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
    today,
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
  res.json({ schedule: await toView(req.user!.id, row) });
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
  res.json({ schedule: await toView(req.user!.id, row) });
});

// --- Day overrides (phase 16B) ----------------------------------------------
//
// The calendar in the Schedule panel reads and writes these. ONE override per
// Manila day — `skip` (leave, an intended miss) or `work` (a holiday the user
// works anyway) — and setting one REPLACES the other. The Workday gate reads
// the same rows at precedence 1, so a change takes effect on the next tick with
// no restart (that is what replaced the EXTRA_WORKDAYS config idea).

const MAX_RANGE_DAYS = 92;

/** A real calendar date, not merely the YYYY-MM-DD shape ("2026-02-31" is out). */
function isRealDate(dateStr: string): boolean {
  if (!DATE_RE.test(dateStr)) return false;
  try {
    // manilaNoon rolls an overflowing day forward ("2026-02-31" -> 2026-03-03),
    // so the round-trip is what rejects it.
    return manilaDateString(manilaNoon(dateStr)) === dateStr;
  } catch {
    return false;
  }
}

/** Whole days from `from` to `to` inclusive. */
function spanDays(from: string, to: string): number {
  return (
    Math.round(
      (manilaNoon(to).getTime() - manilaNoon(from).getTime()) / 86_400_000,
    ) + 1
  );
}

const daysQuerySchema = z
  .object({
    from: z.string().regex(DATE_RE, "from must be YYYY-MM-DD"),
    to: z.string().regex(DATE_RE, "to must be YYYY-MM-DD"),
  })
  .strict();

const dayOverrideSchema = z
  .object({
    kind: z.enum(["skip", "work"]),
    note: z
      .string()
      .trim()
      .max(100, "note must be 100 characters or fewer")
      .optional(),
  })
  .strict();

type DayView = {
  date: string;
  work: boolean;
  reason: WorkdayReason;
  override: { kind: "skip" | "work"; note: string | null } | null;
};

function toDayView(d: DayDecision): DayView {
  return {
    date: d.manilaDate,
    work: d.work,
    reason: d.reason,
    override: d.override,
  };
}

/** The `:date` route param, whatever Express 5 hands us. */
function dayParam(req: Request): string {
  const value = req.params["date"];
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/**
 * Setting or clearing an override for TODAY can turn today into a skip. When it
 * does, a retry the scheduler already promised must not fire against it — the
 * user has just said "do not clock me today". (Phase 16B: "Changing an override
 * for today cancels a pending retry for that day when the new decision is
 * 'skip'".)
 */
async function cancelTodayRetriesIfSkipped(
  userId: string,
  dateStr: string,
): Promise<void> {
  if (dateStr !== manilaDateString(new Date())) return;
  const decision = await decideDay({ userId, manilaDate: dateStr });
  if (!decision.work) {
    await cancelPendingRetriesForDay(userId, dateStr);
  }
}

/**
 * GET /schedule/days?from=&to= — the gate's decision and reason for each day in
 * the range, plus the user's own override. The calendar renders from this one
 * call; the frontend never re-implements the gate.
 */
scheduleRouter.get("/days", async (req: Request, res: Response) => {
  const parsed = daysQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const { from, to } = parsed.data;
  if (!isRealDate(from) || !isRealDate(to)) {
    res.status(400).json({ error: "from and to must be real YYYY-MM-DD dates." });
    return;
  }
  if (to < from) {
    res.status(400).json({ error: "to must be on or after from." });
    return;
  }
  const span = spanDays(from, to);
  if (span > MAX_RANGE_DAYS) {
    res.status(400).json({
      error: `Ask for at most ${MAX_RANGE_DAYS} days at a time (that range is ${span}).`,
    });
    return;
  }

  const days = await decideRange({
    userId: req.user!.id,
    from,
    to,
  });
  res.json({ days: days.map(toDayView) });
});

/**
 * PUT /schedule/days/:date — set (or replace) the user's override for one day.
 * Past days are rejected: today counts as allowed, because a same-morning
 * "skip today" (before the 05:30 fire) is a real thing to want.
 */
scheduleRouter.put("/days/:date", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const dateStr = dayParam(req);
  if (!isRealDate(dateStr)) {
    res.status(400).json({ error: "Date must be a real YYYY-MM-DD Manila day." });
    return;
  }
  if (dateStr < manilaDateString(new Date())) {
    res
      .status(400)
      .json({ error: "Overrides can only be set for today or a future day." });
    return;
  }
  const parsed = dayOverrideSchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const { kind } = parsed.data;
  // An empty note is stored as "no note" so the column means one thing.
  const note = parsed.data.note ? parsed.data.note : null;

  await db
    .insert(dayOverrides)
    .values({ userId, manilaDate: dateStr, kind, note })
    .onConflictDoUpdate({
      target: [dayOverrides.userId, dayOverrides.manilaDate],
      set: { kind, note },
    });

  // The EVENT is audited; the note text never is (it is user free text, and the
  // audit trail records what changed, not what was said — §03 secrets rule).
  await recordAudit("day_override_set", {
    userId,
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
    metadata: { date: dateStr, kind },
  });

  await cancelTodayRetriesIfSkipped(userId, dateStr);
  const decision = await decideDay({ userId, manilaDate: dateStr });
  res.json({ day: toDayView(decision) });
});

/**
 * DELETE /schedule/days/:date — clear the user's override for one day. Safe to
 * call when none exists (idempotent); the audit row is written only when a row
 * was actually removed.
 */
scheduleRouter.delete("/days/:date", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const dateStr = dayParam(req);
  if (!isRealDate(dateStr)) {
    res.status(400).json({ error: "Date must be a real YYYY-MM-DD Manila day." });
    return;
  }
  if (dateStr < manilaDateString(new Date())) {
    res
      .status(400)
      .json({ error: "Overrides can only be cleared for today or a future day." });
    return;
  }

  const removed = await db
    .delete(dayOverrides)
    .where(
      and(
        eq(dayOverrides.userId, userId),
        eq(dayOverrides.manilaDate, dateStr),
      ),
    )
    .returning({ id: dayOverrides.id });

  if (removed.length > 0) {
    await recordAudit("day_override_cleared", {
      userId,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
      metadata: { date: dateStr },
    });
  }

  await cancelTodayRetriesIfSkipped(userId, dateStr);
  const decision = await decideDay({ userId, manilaDate: dateStr });
  res.json({ day: toDayView(decision) });
});
