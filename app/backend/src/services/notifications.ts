import { and, eq, gte } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db/client";
import {
  missedRunNotices,
  notificationSettings,
  runs,
  schedules,
  type Run,
  type Schedule,
} from "../db/schema";
import { decryptOptional } from "../lib/encryption";
import { recordAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import { isPausedOn, isPhilippineHoliday, manilaDateString } from "../lib/ph-holidays";
import { stripAnsi, truncateText } from "../lib/text";
import {
  escapeHtml,
  sendTelegramMessage,
  type TelegramSendResult,
} from "../lib/telegram";
import type { ClockAction } from "../automation/clock";

// Policy for notifications. Deliberately HTTP-free (the transport lives in
// lib/telegram.ts) and DB-aware (settings, blocked-count, the idempotency
// ledger) — each half is testable without the other.

const AUTO_DISABLE_THRESHOLD = 3;
const CHAT_ID_RE = /^-?\d+$/;
// A skip is only "benign" when the already-clocked guard found a matching row.
// This marker matches the fail-safe branch (could not locate/verify) — the
// case where the user is probably NOT clocked in (phase 6 rationale).
const UNSAFE_SKIP_RE = /safety measure|Could not/;

export type DispatchKind = "success" | "failure" | "skipped" | "missed";
export type DispatchOutcome = "skipped" | "sent" | "failed";

type SendFn = (
  botToken: string,
  chatId: string,
  html: string,
) => Promise<TelegramSendResult>;

const TOGGLE_FOR_KIND: Record<
  DispatchKind,
  | "notifyOnSuccess"
  | "notifyOnFailure"
  | "notifyOnSkipped"
  | "notifyOnMissed"
> = {
  success: "notifyOnSuccess",
  failure: "notifyOnFailure",
  skipped: "notifyOnSkipped",
  missed: "notifyOnMissed",
};

// --- Time / message rendering (pure, unit-testable) -------------------------

const timeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Manila",
  hour: "2-digit",
  minute: "2-digit",
});

function formatManilaDay(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  const weekday = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Manila",
    weekday: "short",
  }).format(dt);
  const dayMonth = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Manila",
    day: "2-digit",
    month: "short",
  }).format(dt);
  return `${weekday} ${dayMonth}`;
}

export function renderRunFinishedMessage(params: {
  action: ClockAction;
  status: "success" | "skipped" | "failure";
  error: string | null;
  skipReason: string | null;
  date: Date;
}): string {
  const { action, status, error, skipReason, date } = params;
  const label = action === "in" ? "Clock-in" : "Clock-out";
  const time = timeFormatter.format(date);
  const day = formatManilaDay(manilaDateString(date));

  if (status === "success") {
    const doneLabel = action === "in" ? "Clocked in" : "Clocked out";
    return `✅ <b>${doneLabel}</b>\n${time} · ${day}`;
  }

  if (status === "failure") {
    const reason = error ?? skipReason;
    const body = reason
      ? `\n${escapeHtml(truncateText(stripAnsi(reason)))}`
      : "";
    return `⚠️ <b>${label} failed</b>\n${time} · ${day}${body}`;
  }

  // The reason is the run's skipReason — never a lifecycle step, so the
  // fail-safe branches (could not locate/verify) stay distinguishable.
  const reason = skipReason ? stripAnsi(skipReason) : null;
  if (reason && UNSAFE_SKIP_RE.test(reason)) {
    return (
      `⚠️ <b>${label} skipped — could not verify</b>\n${time} · ${day}\n` +
      `${escapeHtml(truncateText(reason))}\n` +
      `You may NOT be clocked in. Check HRHub.`
    );
  }
  const body = reason ? `\n${escapeHtml(truncateText(reason))}` : "";
  return `ℹ️ <b>${label} skipped</b>\n${time} · ${day}${body}`;
}

export function renderMissedMessage(
  action: ClockAction,
  expectedTime: string,
  dateStr: string,
): string {
  const label = action === "in" ? "Clock-in" : "Clock-out";
  const verb = action === "in" ? "in" : "out";
  const hhmm = expectedTime.length >= 5 ? expectedTime.slice(0, 5) : expectedTime;
  return (
    `🔴 <b>${label} did not run</b>\nExpected ${hhmm} · ${formatManilaDay(dateStr)}\n\n` +
    `No run was recorded today. The scheduler may have been asleep or the ` +
    `server down. Clock ${verb} manually if you haven't already.`
  );
}

// --- The single send path ---------------------------------------------------

/**
 * dispatch(userId, html, kind) — the only way a notification is sent.
 *
 * Returns three states on purpose: "skipped" (don't-send) must NEVER reset
 * blockedCount, or a user with notifications off would silently clear their
 * own blocked history; "sent" resets it; "failed" leaves it alone except for
 * consecutive "blocked" errors, which count toward auto-disable.
 */
export async function dispatch(
  userId: string,
  html: string,
  kind: DispatchKind,
  send: SendFn = sendTelegramMessage,
): Promise<DispatchOutcome> {
  const [settings] = await db
    .select()
    .from(notificationSettings)
    .where(eq(notificationSettings.userId, userId))
    .limit(1);
  if (!settings || !settings.enabled) return "skipped";
  if (!settings[TOGGLE_FOR_KIND[kind]]) return "skipped";

  const botToken = decryptOptional(settings.telegramBotTokenEnc);
  const chatId = settings.telegramChatId;
  if (!botToken || !chatId || !CHAT_ID_RE.test(chatId)) return "skipped";

  const result = await send(botToken, chatId, html);
  if (result.ok) {
    if (settings.blockedCount > 0) {
      await db
        .update(notificationSettings)
        .set({ blockedCount: 0 })
        .where(eq(notificationSettings.userId, userId));
    }
    return "sent";
  }

  if (result.error === "blocked") {
    const blockedCount = settings.blockedCount + 1;
    if (blockedCount >= AUTO_DISABLE_THRESHOLD) {
      await db
        .update(notificationSettings)
        .set({ enabled: false, blockedCount })
        .where(eq(notificationSettings.userId, userId));
      await recordAudit("notification_auto_disabled", {
        userId,
        metadata: { blockedCount, reason: "consecutive_blocked" },
      });
    } else {
      await db
        .update(notificationSettings)
        .set({ blockedCount })
        .where(eq(notificationSettings.userId, userId));
    }
    return "failed";
  }

  // Any other error (network, rate_limited, …): a blip is not the user blocking
  // the bot, and conflating them auto-disables people during an outage.
  logger.warn({ userId, kind, error: result.error }, "telegram dispatch failed");
  return "failed";
}

/**
 * Builds and dispatches the terminal-state run message. Never throws — the
 * .catch in the caller is belt-and-braces only.
 */
export async function notifyRunFinished(params: {
  run: Run;
  status?: "success" | "skipped" | "failure";
  error?: string | null;
  skipReason: string | null;
}): Promise<DispatchOutcome> {
  try {
    const { run, skipReason } = params;
    const status = params.status ?? run.status;
    if (status !== "success" && status !== "skipped" && status !== "failure") {
      return "skipped";
    }
    const error = params.error !== undefined ? params.error : run.error;
    const html = renderRunFinishedMessage({
      action: run.action,
      status,
      error,
      skipReason,
      date: run.startedAt,
    });
    return dispatch(run.userId, html, status);
  } catch (err: unknown) {
    logger.error({ runId: params.run.id, err }, "notifyRunFinished failed");
    return "failed";
  }
}

// --- Missed-run reconciliation ----------------------------------------------

/** "YYYY-MM-DD" Manila date; true for Saturday/Sunday. */
export function isWeekend(dateStr: string): boolean {
  const [y, m, d] = dateStr.split("-").map(Number);
  const day = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  return day === 0 || day === 6;
}

/** The instant a schedule time (Manila wall clock) fires on `dateStr`. */
export function expectedFireTime(dateStr: string, timeStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [h, min] = timeStr.split(":").map(Number);
  if (!y || !m || !d || h === undefined || min === undefined) {
    throw new Error(`expectedFireTime: invalid date/time ${dateStr} ${timeStr}`);
  }
  // dateStr/timeStr are Asia/Manila wall time; Manila is UTC+8 year-round.
  return new Date(Date.UTC(y, m - 1, d, h, min) - 8 * 60 * 60 * 1000);
}

export type SweepDeps = {
  now: () => Date;
  isWorkday: (date: Date) => boolean;
  loadEnabledSchedules: () => Promise<Schedule[]>;
  hasRunToday: (
    userId: string,
    action: ClockAction,
    dateStr: string,
  ) => Promise<boolean>;
  // "claimed" = this sweep inserted the notice row and owns the send.
  // "retry"  = the row already exists but was never notified (send failed or
  //            was skipped earlier) — a later sweep may try again.
  // "done"   = the row exists and was notified — never send twice.
  tryInsertMissedNotice: (
    userId: string,
    action: ClockAction,
    dateStr: string,
  ) => Promise<"claimed" | "retry" | "done">;
  markNoticeNotified: (
    userId: string,
    action: ClockAction,
    dateStr: string,
  ) => Promise<void>;
  dispatchMissed: (userId: string, html: string) => Promise<DispatchOutcome>;
};

export const defaultSweepDeps: SweepDeps = {
  now: () => new Date(),
  isWorkday: (date) =>
    !isWeekend(manilaDateString(date)) && !isPhilippineHoliday(date),
  loadEnabledSchedules: async () =>
    db.select().from(schedules).where(eq(schedules.enabled, true)),
  hasRunToday: async (userId, action, dateStr) => {
    // Fetch the user's runs since now - 24h and filter in JS with
    // manilaDateString — avoids timezone arithmetic in SQL.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.userId, userId),
          eq(runs.action, action),
          gte(runs.startedAt, since),
        ),
      );
    return rows.some((r) => manilaDateString(r.startedAt) === dateStr);
  },
  tryInsertMissedNotice: async (userId, action, dateStr) => {
    // The database decides who sends, not application logic: onConflictDoNothing
    // means a conflicting (user, date, action) returns NO row, and only a real
    // insert returns one. Two overlapping sweeps cannot double-insert. When the
    // insert loses the conflict, the existing row decides (backlog #4): if it
    // was never notified, a later sweep retries the send; if it was, skip.
    const [inserted] = await db
      .insert(missedRunNotices)
      .values({ userId, manilaDate: dateStr, action })
      .onConflictDoNothing({
        target: [
          missedRunNotices.userId,
          missedRunNotices.manilaDate,
          missedRunNotices.action,
        ],
      })
      .returning();
    if (inserted !== undefined) return "claimed";
    const [existing] = await db
      .select({ notifiedAt: missedRunNotices.notifiedAt })
      .from(missedRunNotices)
      .where(
        and(
          eq(missedRunNotices.userId, userId),
          eq(missedRunNotices.manilaDate, dateStr),
          eq(missedRunNotices.action, action),
        ),
      )
      .limit(1);
    return existing?.notifiedAt == null ? "retry" : "done";
  },
  markNoticeNotified: async (userId, action, dateStr) => {
    await db
      .update(missedRunNotices)
      .set({ notifiedAt: new Date() })
      .where(
        and(
          eq(missedRunNotices.userId, userId),
          eq(missedRunNotices.manilaDate, dateStr),
          eq(missedRunNotices.action, action),
        ),
      );
  },
  dispatchMissed: async (userId, html) => dispatch(userId, html, "missed"),
};

/**
 * The feature the whole phase exists for: a process that is down cannot report
 * that it is down, so a sweep running on a live process reconciles what should
 * have happened against what did. Must never throw across the cron boundary.
 */
export async function sweepMissedRuns(
  deps: SweepDeps = defaultSweepDeps,
): Promise<void> {
  try {
    const now = deps.now();
    // Same rules as fireCron: a weekend or holiday is not a missed run.
    if (!deps.isWorkday(now)) return;

    const todayStr = manilaDateString(now);
    const graceMs = config.MISSED_RUN_GRACE_MINUTES * 60 * 1000;
    const rows = await deps.loadEnabledSchedules();

    for (const row of rows) {
      // A paused day is not a missed run — alerting on it would train the user
      // to ignore the alerts. Same rule as fireCron: skip, don't notify.
      if (isPausedOn(row, now)) continue;

      for (const action of ["in", "out"] as const) {
        const timeStr = action === "in" ? row.clockInTime : row.clockOutTime;
        const expected = expectedFireTime(todayStr, timeStr);
        // Grace window absorbs queue wait and a slow HRHub.
        if (now.getTime() < expected.getTime() + graceMs) continue;

        const hasRun = await deps.hasRunToday(row.userId, action, todayStr);
        if (hasRun) continue;

        const claim = await deps.tryInsertMissedNotice(
          row.userId,
          action,
          todayStr,
        );
        if (claim === "done") continue;

        const html = renderMissedMessage(action, timeStr, todayStr);
        const outcome = await deps.dispatchMissed(row.userId, html);
        // Only a successful send is terminal. A failed — or deliberately
        // skipped — send leaves notified_at NULL so a later sweep retries it;
        // the missed alert is precisely the one where silence is worst
        // (backlog #4). The unique index already prevents a double-notify for
        // successful sends, so the insert-then-send order stays.
        if (outcome === "sent") {
          await deps.markNoticeNotified(row.userId, action, todayStr);
        }
      }
    }
  } catch (err: unknown) {
    logger.error({ err }, "sweepMissedRuns failed");
  }
}
