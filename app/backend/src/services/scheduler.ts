import cron, { type ScheduledTask } from "node-cron";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { schedules, type Schedule } from "../db/schema";
import { logger } from "../lib/logger";
import { isPausedOn } from "../lib/ph-holidays";
import { resolveHolidayDecision } from "./holidays";
import { startRun } from "./runs";
import { sweepMissedRuns, notifyHolidaySkip } from "./notifications";
import { pingHeartbeat } from "../lib/heartbeat";
import type { ClockAction } from "../automation/clock";

type UserTasks = { clockIn: ScheduledTask; clockOut: ScheduledTask };

// userId -> the two live cron tasks. Module-global on purpose: one scheduler
// per process.
const active = new Map<string, UserTasks>();

// Timestamp (ISO) of the last cron fire, any user, any action. Updated at the
// top of fireCron — the moment cron actually invoked the scheduler — regardless
// of whether the fire then enqueued a run, skipped a holiday, or was paused.
// Exposed to /health so an uptime monitor can see cron is alive, not just that
// the process is up. NULL until the first fire (see 12A).
let lastFireAt: string | null = null;

export function schedulerLastFireAt(): string | null {
  return lastFireAt;
}

/** Count of enabled schedules in the database (what SHOULD be registered). */
export async function enabledScheduleCount(): Promise<number> {
  const rows = await db
    .select()
    .from(schedules)
    .where(eq(schedules.enabled, true));
  return rows.length;
}

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
  // node-cron v4 types stop() as void | Promise<void> (inline tasks — the ones
  // this scheduler creates — return void at runtime); the union makes oxlint's
  // no-floating-promises flag it, so mark the deliberate non-await explicitly.
  void tasks.clockIn.stop();
  void tasks.clockOut.stop();
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
  // Record the fire first — cron is alive whether or not the fire then enqueues
  // a run. /health reads this as the "scheduler last fired" timestamp (12A).
  lastFireAt = now.toISOString();
  // Dead-man's-switch heartbeat: ping outward on EVERY fire, before anything
  // else. Fire-and-forget and a no-op when HEARTBEAT_URL is unset; a dead or
  // hanging endpoint can never affect the run (hard rules 2 & 11).
  pingHeartbeat();
  const decision = await resolveHolidayDecision(now);
  if (decision.skip) {
    logger.info(
      {
        userId,
        action,
        holiday: decision.skip.name,
        type: decision.skip.type,
        source: decision.skip.source,
      },
      "skipping scheduled run — Philippine holiday",
    );
    // Notify on an `optional` (special non-working day), an `override`
    // (operator-typed), or a `gazette` (proclamation) skip — a `public` library
    // holiday stays silent. The Gazette disagreement note (library's lunar date
    // vs proclaimed date) is appended when present. Fire-and-forget: a dead
    // Telegram endpoint must not change the skip decision or delay anything
    // (hard rule 11). Idempotent via the database (one notice per user per
    // Manila day), so the in/out fires of the same day and a restart cannot
    // duplicate it.
    void notifyHolidaySkip(userId, decision.skip, now, {
      note: decision.disagreementNote,
    }).catch(() => {}); // oxlint-disable-line promise/prefer-await-to-then -- sanctioned fire-and-forget idiom (#2), §03.
    return;
  }
  // A "possible" holiday (regional/ambiguous gazette proclamation) does NOT
  // skip — but the human should be told so they can decide. Notify without
  // blocking the run (fire-and-forget), then proceed to enqueue normally.
  if (decision.possible) {
    void notifyHolidaySkip(userId, decision.possible, now, {
      possible: true,
    }).catch(() => {}); // oxlint-disable-line promise/prefer-await-to-then -- sanctioned fire-and-forget idiom (#2), §03.
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
