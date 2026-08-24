import { and, eq, gte } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db/client";
import {
  holidaySkipNotices,
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
import {
  isPausedOn,
  manilaDateString,
  type HolidayInfo,
} from "../lib/ph-holidays";
import { stripAnsi, truncateText } from "../lib/text";
import {
  escapeHtml,
  sendTelegramMessage,
  type TelegramSendResult,
} from "../lib/telegram";
import type { ClockAction } from "../automation/clock";
import { resolveHolidayDecision } from "./holidays";
import { hasPendingRetry as hasPendingRetryFromRegistry } from "./retry-registry";

// Policy for notifications. Deliberately HTTP-free (the transport lives in
// lib/telegram.ts) and DB-aware (settings, blocked-count, the idempotency
// ledger) — each half is testable without the other.

const AUTO_DISABLE_THRESHOLD = 3;
const CHAT_ID_RE = /^-?\d+$/;
// A skip is only "benign" when the already-clocked guard found a matching row.
// This marker matches the fail-safe branch (could not locate/verify) — the
// case where the user is probably NOT clocked in (phase 6 rationale).
const UNSAFE_SKIP_RE = /safety measure|Could not/;

export type DispatchKind =
  | "success"
  | "failure"
  | "skipped"
  | "missed"
  | "holiday"
  | "retry";
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
  // A holiday skip is "the automation did not run today, here's why" — the
  // same class of informational alert as a missed run, so it honours the
  // missed toggle (phase 11; no new toggle column).
  holiday: "notifyOnMissed",
  // A retry-scheduled / give-up message (phase 14) is a failure-adjacent
  // alert — the user's run failed and needs (or had) retrying — so it honours
  // the failure toggle. No new toggle column.
  retry: "notifyOnFailure",
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

/**
 * The "holiday skip" reminder (phase 11 + 13). Sent when the scheduler skips a
 * run because of a holiday that ISN'T a plain `public` library holiday: an
 * `optional` (special non-working day, phase 11), an operator `override`
 * (phase 13A — always notifies, a human typed it), or a `gazette` proclamation
 * (phase 13B). A `public` library holiday stays silent. The message names the
 * day and that the "Clock in now" button is there if they're working anyway;
 * override/gazette skips name their source, and an optional `note` (the Gazette
 * lunar-date disagreement) is appended when present.
 */
export function renderHolidaySkipMessage(
  holiday: HolidayInfo,
  dateStr: string,
  note: string | null = null,
): string {
  const name = escapeHtml(holiday.name);
  const day = formatManilaDay(dateStr);
  let line: string;
  if (holiday.source === "override") {
    line = `🏖️ <b>${name}</b> is a holiday today (operator override) · ${day}`;
  } else if (holiday.source === "gazette") {
    line = `🏖️ <b>${name}</b> is a national holiday today (Official Gazette proclamation) · ${day}`;
  } else {
    line = `🏖️ <b>${name}</b> is a special non-working day today (${day})`;
  }
  const noteLine = note ? `\n${escapeHtml(note)}` : "";
  return `${line}.\nNo clock was scheduled. Working after all? <b>Clock in now</b>.${noteLine}`;
}

/**
 * The "possible holiday" reminder (phase 13B). Sent for a regional/ambiguous
 * Gazette proclamation — we do NOT skip (the scheduler still runs), but the
 * human is told so they can decide whether today is actually a holiday for them.
 */
export function renderPossibleHolidayMessage(
  holiday: HolidayInfo,
  dateStr: string,
): string {
  const name = escapeHtml(holiday.name);
  const day = formatManilaDay(dateStr);
  return (
    `🔎 <b>Possible holiday</b> · ${day}\n` +
    `${name} is listed in the Official Gazette for this date, but only for a ` +
    `specific area. The scheduler ran as normal — check whether you're working.`
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

/**
 * The holiday notification, called from fireCron on a holiday skip (or a
 * "possible holiday" that does NOT skip). Distinct from the run-finished
 * dispatch because there is NO run row — fireCron returns before any runs
 * insert.
 *
 * Idempotent via the database (the same "let the database decide" pattern as
 * the missed-run notices): we insert a holiday_skip_notices row keyed on
 * (user_id, manila_date) and only the insert-winner sends. The key omits
 * `action` so the in/out cron fires of the same day produce ONE message, and a
 * container restart cannot duplicate it. No state is held in memory.
 *
 * What fires (phase 11 + 13): an `optional` (special non-working day), an
 * operator `override` (always), or a `gazette` proclamation. A `public`
 * library holiday stays silent — nobody needs a Christmas Day message, and a
 * channel that fires on every predictable holiday is a channel people mute.
 *
 * This is deliberately fire-and-forget (callers use `.catch(() => {})`): a dead
 * Telegram endpoint must not change the skip decision or delay anything (hard
 * rule 11). The `send` param is for tests.
 */
export async function notifyHolidaySkip(
  userId: string,
  holiday: HolidayInfo,
  now: Date,
  optsOrSend?: { possible?: boolean; note?: string | null } | SendFn,
  send: SendFn = sendTelegramMessage,
): Promise<"sent" | "skipped"> {
  // Backward-compatible: phase-11 callers passed `send` as the 4th arg. Accept
  // either an options object (phase 13) or a send function there.
  const opts =
    typeof optsOrSend === "function" ? {} : (optsOrSend ?? {});
  const actualSend = typeof optsOrSend === "function" ? optsOrSend : send;

  // Silent ONLY for a plain `public` library holiday. Overrides and gazette
  // skips always notify; `optional` (special non-working days) notify; a
  // "possible" (regional/ambiguous gazette) notification always fires.
  if (holiday.type !== "optional" && holiday.source === "library") {
    return "skipped";
  }
  const dateStr = manilaDateString(now);

  // The database decides who sends: onConflictDoNothing means a conflicting
  // (user, date) returns NO row, and only a real insert returns one. Two
  // overlapping fires cannot double-insert or double-send.
  const [inserted] = await db
    .insert(holidaySkipNotices)
    .values({ userId, manilaDate: dateStr })
    .onConflictDoNothing({
      target: [holidaySkipNotices.userId, holidaySkipNotices.manilaDate],
    })
    .returning();
  if (inserted === undefined) return "skipped";

  const html = opts.possible
    ? renderPossibleHolidayMessage(holiday, dateStr)
    : renderHolidaySkipMessage(holiday, dateStr, opts.note ?? null);
  const outcome = await dispatch(userId, html, "holiday", actualSend);
  return outcome === "sent" ? "sent" : "skipped";
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
  isWorkday: (date: Date) => boolean | Promise<boolean>;
  loadEnabledSchedules: () => Promise<Schedule[]>;
  hasRunToday: (
    userId: string,
    action: ClockAction,
    dateStr: string,
    now: Date,
  ) => Promise<boolean>;
  // Phase 14: whether a retry is currently pending for (user, action, date).
  // When it is, the sweep must NOT also send a missed-run alert — both would
  // describe the same morning and train the user to distrust both.
  hasPendingRetry: (
    userId: string,
    action: ClockAction,
    dateStr: string,
  ) => boolean;
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
  isWorkday: async (date) =>
    !isWeekend(manilaDateString(date)) &&
    (await resolveHolidayDecision(date)).skip === null,
  loadEnabledSchedules: async () =>
    db.select().from(schedules).where(eq(schedules.enabled, true)),
  hasRunToday: async (userId, action, dateStr, now) => {
    // Fetch the user's runs since now - 24h and filter in JS with
    // manilaDateString — avoids timezone arithmetic in SQL. The window is
    // anchored to the sweep's clock (now), not the wall clock: a sweep test
    // pins `now` to a fixed instant and the run lookup must agree with it.
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
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
  hasPendingRetry: (userId, action, dateStr) =>
    hasPendingRetryFromRegistry(userId, action, dateStr),
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
    // Same rules as fireCron: a weekend or holiday is not a missed run. A
    // "possible" (regional/ambiguous gazette) holiday does NOT skip, so it is
    // still a workday for the sweep — the run was expected to proceed.
    if (!(await deps.isWorkday(now))) return;

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

        const hasRun = await deps.hasRunToday(row.userId, action, todayStr, now);
        // A retry is pending: the morning is being handled — a missed-run alert
        // would duplicate the retry messages and train the user to distrust
        // both (phase 14B). Suppress.
        if (hasRun || deps.hasPendingRetry(row.userId, action, todayStr)) {
          continue;
        }

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
