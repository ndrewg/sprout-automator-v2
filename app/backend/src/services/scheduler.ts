import cron, { type ScheduledTask } from "node-cron";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { schedules, type Schedule } from "../db/schema";
import { logger } from "../lib/logger";
import { isPausedOn, isPhilippineHoliday } from "../lib/ph-holidays";
import { startRun } from "./runs";
import { sweepMissedRuns } from "./notifications";
import type { ClockAction } from "../automation/clock";

type UserTasks = { clockIn: ScheduledTask; clockOut: ScheduledTask };

// userId -> the two live cron tasks. Module-global on purpose: one scheduler
// per process.
const active = new Map<string, UserTasks>();

/**
 * "05:30" or "05:30:00" -> "30 5 * * 1-5" (weekdays Mon–Fri).
 * The Mon–Fri restriction lives in the cron expression, not the handler.
 */
export function timeToCronExpression(time: string): string {
  const parts = time.split(":");
  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`Invalid hour in time: ${time}`);
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error(`Invalid minute in time: ${time}`);
  }
  return `${minute} ${hour} * * 1-5`;
}

export function registerSchedule(row: Schedule): void {
  // Atomic swap: always clear any existing tasks first.
  unregisterSchedule(row.userId);
  if (!row.enabled) return;

  const inExpr = timeToCronExpression(row.clockInTime);
  const outExpr = timeToCronExpression(row.clockOutTime);
  const clockIn = cron.schedule(inExpr, () => void fireCron(row.userId, "in"), {
    timezone: "Asia/Manila",
  });
  const clockOut = cron.schedule(
    outExpr,
    () => void fireCron(row.userId, "out"),
    { timezone: "Asia/Manila" },
  );
  active.set(row.userId, { clockIn, clockOut });
  logger.info(
    { userId: row.userId, in: inExpr, out: outExpr, timezone: "Asia/Manila" },
    "schedule registered",
  );
}

export function unregisterSchedule(userId: string): void {
  const tasks = active.get(userId);
  if (!tasks) return;
  tasks.clockIn.stop();
  tasks.clockOut.stop();
  active.delete(userId);
  logger.info({ userId }, "schedule unregistered");
}

export function activeScheduleCount(): number {
  return active.size;
}

export async function loadAllSchedules(): Promise<number> {
  const rows = await db
    .select()
    .from(schedules)
    .where(eq(schedules.enabled, true));
  for (const row of rows) {
    registerSchedule(row);
  }
  return active.size;
}

/**
 * The missed-run reconciliation sweep: ONE global task for all users, started
 * at boot (from index.ts). A process that is down cannot report that it is
 * down, so a sweep on a live process reconciles what should have happened
 * against what did. sweepMissedRuns never throws across the cron boundary.
 */
export function startMissedRunSweep(): void {
  cron.schedule("*/5 * * * *", () => void sweepMissedRuns(), {
    timezone: "Asia/Manila",
  });
  logger.info(
    { expression: "*/5 * * * *", timezone: "Asia/Manila" },
    "missed-run sweep registered",
  );
}

/**
 * Fired by cron. Holiday check FIRST, then the pause window, then enqueue a
 * run. Must never throw across the cron boundary, and does NOT await execution.
 * The `now` param is for tests only — the cron call path uses the default.
 */
export async function fireCron(
  userId: string,
  action: ClockAction,
  now: Date = new Date(),
): Promise<void> {
  const holiday = isPhilippineHoliday(now);
  if (holiday) {
    logger.info(
      { userId, action, holiday },
      "skipping scheduled run — Philippine holiday",
    );
    return;
  }
  try {
    const [schedule] = await db
      .select()
      .from(schedules)
      .where(eq(schedules.userId, userId))
      .limit(1);
    if (schedule && isPausedOn(schedule, now)) {
      // Pause window covers today: suppress automation, exactly like a holiday.
      // Values are not secrets — log them so the skip is explainable.
      logger.info(
        {
          userId,
          action,
          pausedFrom: schedule.pausedFrom,
          pausedUntil: schedule.pausedUntil,
        },
        "skipping scheduled run — paused window",
      );
      return;
    }
    const result = await startRun({ userId, action });
    if (result.ok) {
      logger.info(
        { userId, action, runId: result.run.id },
        "scheduled run enqueued",
      );
    } else {
      logger.info(
        { userId, action, reason: result.reason },
        "scheduled run not started",
      );
    }
  } catch (err: unknown) {
    logger.error({ userId, action, err }, "scheduled run failed to enqueue");
  }
}
