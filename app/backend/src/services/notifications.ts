import { and, eq, gte } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db/client";
import {
  holidaySkipNotices,
  headsUpNotices,
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
import { stripAnsi, truncateText } from "../lib/text";
import {
  escapeHtml,
  sendTelegramMessage,
  type TelegramSendResult,
} from "../lib/telegram";
import type { ClockAction } from "../automation/clock";
import {
  addManilaDays,
  decideDay,
  expectedFireTime,
  formatManilaDay,
  manilaDateString,
  nextWorkday,
  type DayDecision,
  type WorkdayReason,
} from "./workday";
import { hasPendingRetry as hasPendingRetryInDb } from "./retry-state";

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
  | "skip"
  | "heads_up"
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
  | "notifyHeadsUp"
> = {
  success: "notifyOnSuccess",
  failure: "notifyOnFailure",
  skipped: "notifyOnSkipped",
  missed: "notifyOnMissed",
  // A "skipping today" message (a holiday, the user's own skip day, a pause
  // window — phase 16D) is muted by notify_on_skipped. Phase 11 mapped holiday
  // skips to notify_on_missed; phase 16's contract is explicit that the mute is
  // notify_on_skipped, so a user can silence "no clock today" without also
  // silencing the missed-run alert that says the automator did not run.
  skip: "notifyOnSkipped",
  // The evening heads-up (phase 16D) has its own toggle, ON by default.
  heads_up: "notifyHeadsUp",
  // A retry-scheduled / give-up message (phase 14) is a failure-adjacent
  // alert — the user's run failed and needs (or had) retrying — so it honours
  // the failure toggle. No new toggle column.
  retry: "notifyOnFailure",
};

// --- Message rendering (pure, unit-testable) --------------------------------

export function renderRunFinishedMessage(params: {
  action: ClockAction;
  status: "success" | "skipped" | "failure";
  error: string | null;
  skipReason: string | null;
  date: Date;
}): string {
  const { action, status, error, skipReason, date } = params;
  const label = action === "in" ? "Clock-in" : "Clock-out";
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Manila",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
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

/**
 * The missed-run message. Since phase 15C a late wake is ALERT ONLY: a host
 * that comes up after the fire window does not clock in late, because the
 * operator pauses by powering the machine off, so a late automatic clock-in
 * would put a false record on a day off. The message therefore says plainly
 * that the automator was not running and that the human should clock in.
 */
export function renderMissedMessage(
  action: ClockAction,
  expectedTime: string,
  dateStr: string,
): string {
  const label = action === "in" ? "clock-in" : "clock-out";
  const verb = action === "in" ? "in" : "out";
  const hhmm = expectedTime.length >= 5 ? expectedTime.slice(0, 5) : expectedTime;
  return (
    `🔴 <b>Missed the ${hhmm} ${label}</b>\n${formatManilaDay(dateStr)}\n\n` +
    `The automator wasn't running at ${hhmm}. ` +
    `Clock ${verb} yourself if you're working today.`
  );
}

/**
 * The "skipping today" message (phase 16D). Every skip notifies now, with its
 * reason — a library holiday (which used to be silent, hiding a wrong library
 * date until HR noticed), a holiday the operator added, a day the user marked
 * as a skip, or a pause window. Weekends never notify.
 *
 * The dashboard link is there so a wrong call can be flipped in the calendar.
 */
export function renderSkipMessage(
  reason: WorkdayReason,
  dateStr: string,
  appUrl: string,
): string {
  const day = formatManilaDay(dateStr);
  const link = `<a href="${escapeHtml(appUrl)}">Change it in the dashboard</a>`;
  return (
    `⏭️ <b>Skipping today</b>: ${escapeHtml(reason.label)}\n` +
    `${day}\n` +
    `No clock was scheduled. Working after all? Clock in at HRHub, or ${link}.`
  );
}

/**
 * The evening heads-up (phase 16D). Sent once, after the user's scheduled
 * clock-out run reaches an outcome, naming the NEXT workday's decision:
 *
 *   "Next: Mon 26 Oct 05:30 clock-in."
 *   "Tomorrow (Mon 2 Nov) is All Souls' Day (special non-working), so no
 *    clock-in. Next clock-in: Tue 05:30."
 *   "Mon 2 Nov is a day you marked as a workday, so clocking in at 05:30."
 *
 * `next` is the gate's decision for the next work day (which may be later than
 * tomorrow), `tomorrow` is the gate's decision for tomorrow. Always carries a
 * dashboard link, so a wrong call can be flipped in the calendar before the
 * morning it would have mattered.
 */
export function renderHeadsUpMessage(params: {
  clockInTime: string;
  tomorrowDate: string;
  tomorrow: { work: boolean; reason: WorkdayReason };
  next: { manilaDate: string; reason: WorkdayReason };
  appUrl: string;
}): string {
  const { clockInTime, tomorrowDate, tomorrow, next, appUrl } = params;
  const hhmm = clockInTime.length >= 5 ? clockInTime.slice(0, 5) : clockInTime;
  const link = `<a href="${escapeHtml(appUrl)}">Open the dashboard</a>`;
  const tomorrowDay = formatManilaDay(tomorrowDate);
  const nextDay = formatManilaDay(next.manilaDate);
  const nextWeekday = nextDay.split(" ")[0];

  if (next.manilaDate === tomorrowDate) {
    if (tomorrow.reason.code === "work_override") {
      return (
        `🌙 <b>Heads-up</b>\n` +
        `${tomorrowDay} is a day you marked as a workday, so clocking in at ${hhmm}.\n` +
        `${link}`
      );
    }
    return (
      `🌙 <b>Heads-up</b>\n` +
      `Next: ${nextDay} ${hhmm} clock-in.\n` +
      `${link}`
    );
  }

  return (
    `🌙 <b>Heads-up</b>\n` +
    `Tomorrow (${tomorrowDay}) is ${escapeHtml(tomorrow.reason.label)}, so no clock-in. ` +
    `Next clock-in: ${nextWeekday} ${hhmm}.\n` +
    `${link}`
  );
}

// --- The single send path ---------------------------------------------------

/**
 * dispatch(userId, html, kind, send) — the only way a notification is sent.
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
 * The "skipping today" notification, called from fireCron when the Workday gate
 * says today is not a work day. Distinct from the run-finished dispatch because
 * there is NO run row — fireCron returns before any runs insert.
 *
 * Idempotent via the database (the same "let the database decide" pattern as
 * the missed-run notices): we insert a `holiday_skip_notices` row keyed on
 * (user_id, manila_date) and only the insert-winner sends. The key omits
 * `action` so the in/out fires of the same day produce ONE message, and a
 * container restart cannot duplicate it. No state is held in memory.
 * (The table keeps its phase-11 name; since phase 16D it carries EVERY skip,
 * not only holidays.)
 *
 * This is deliberately fire-and-forget (callers use `.catch(() => {})`): a dead
 * Telegram endpoint must not change the skip decision or delay anything (hard
 * rule 11). The `send` param is for tests.
 */
export async function notifySkip(params: {
  userId: string;
  decision: DayDecision;
  now: Date;
  send?: SendFn;
}): Promise<"sent" | "skipped"> {
  const { userId, decision } = params;
  if (decision.work) return "skipped";
  // A weekend is not a skip anybody needs telling about. The gate decides
  // work/non-work and `fireCron` asks it, so a weekend reaches here only as a
  // non-work decision that must stay silent. (`dueSlots` no longer filters
  // weekends out — phase 16 review, B1 — so THIS guard is what keeps them
  // quiet.) Returning before the insert means no notice row is written either.
  if (decision.reason.code === "weekend") return "skipped";

  const dateStr = decision.manilaDate;
  const send = params.send ?? sendTelegramMessage;

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

  const html = renderSkipMessage(decision.reason, dateStr, config.APP_URL);
  const outcome = await dispatch(userId, html, "skip", send);
  return outcome === "sent" ? "sent" : "skipped";
}

/**
 * The evening heads-up: ONE message about the next workday's decision, sent
 * after the user's clock-out run reaches an outcome (phase 16D). It is the
 * cross-check that catches a wrong holiday call before it becomes a false
 * record, and it replaces the old "the library says so, trust it".
 *
 * Once per user per Manila day, recorded in the DATABASE (`heads_up_notices`,
 * unique on user+date) — never an in-memory flag, because the process restarts.
 * A second clock-out run, a retry of one, or a container restart therefore
 * cannot duplicate it.
 *
 * Fire-and-forget at the call site (hard rule 11): a dead Telegram endpoint
 * must never change a run's status or timing. The `send` param is for tests.
 */
export type HeadsUpDeps = {
  nextWorkday: (params: {
    userId: string;
    from: string;
    now?: Date;
  }) => Promise<DayDecision | null>;
  loadClockInTime: (userId: string) => Promise<string>;
};

export const defaultHeadsUpDeps: HeadsUpDeps = {
  nextWorkday: (params) => nextWorkday(params),
  loadClockInTime: async (userId) => {
    const [row] = await db
      .select({ clockInTime: schedules.clockInTime })
      .from(schedules)
      .where(eq(schedules.userId, userId))
      .limit(1);
    return row?.clockInTime ?? "05:30:00";
  },
};

export async function notifyHeadsUp(
  params: { userId: string; now: Date },
  send: SendFn = sendTelegramMessage,
  deps: Partial<HeadsUpDeps> = {},
): Promise<"sent" | "skipped"> {
  const d: HeadsUpDeps = { ...defaultHeadsUpDeps, ...deps };
  const { userId, now } = params;
  const today = manilaDateString(now);
  const tomorrowDate = addManilaDays(today, 1);

  const next = await d.nextWorkday({ userId, from: today, now });
  // Nothing ahead but skips: there is no next clock-in to announce, so do not
  // consume the day's slot.
  if (!next) return "skipped";

  const tomorrow: DayDecision = await decideDay({
    userId,
    manilaDate: tomorrowDate,
    now,
  });
  const clockInTime = await d.loadClockInTime(userId);

  // The database decides who sends (the same pattern as the missed-run notices
  // and the skip notices): onConflictDoNothing returns NO row when this user
  // already had a heads-up today.
  const [inserted] = await db
    .insert(headsUpNotices)
    .values({ userId, manilaDate: today })
    .onConflictDoNothing({
      target: [headsUpNotices.userId, headsUpNotices.manilaDate],
    })
    .returning();
  if (inserted === undefined) return "skipped";

  const html = renderHeadsUpMessage({
    clockInTime,
    tomorrowDate,
    tomorrow,
    next,
    appUrl: config.APP_URL,
  });
  const outcome = await dispatch(userId, html, "heads_up", send);
  return outcome === "sent" ? "sent" : "skipped";
}

// --- Missed-run reconciliation ----------------------------------------------

export type SweepDeps = {
  now: () => Date;
  /**
   * Whether this Manila day is a work day FOR THIS USER (phase 16A): the
   * Workday gate's `work` answer, so the sweep sees the same holidays, pause
   * windows and per-user day overrides the scheduler does. A day the gate says
   * to skip is not a missed run — alerting on it would train the user to ignore
   * the alerts.
   */
  isWorkday: (userId: string, manilaDate: string) => boolean | Promise<boolean>;
  loadEnabledSchedules: () => Promise<Schedule[]>;
  hasRunToday: (
    userId: string,
    action: ClockAction,
    dateStr: string,
    now: Date,
  ) => Promise<boolean>;
  // Phase 14/15B: whether a retry is currently queued for (user, action, date).
  // When it is, the sweep must NOT also send a missed-run alert — both would
  // describe the same morning and train the user to distrust both. The answer
  // comes from `runs.retry_at` in the database, so it survives a restart (the
  // old in-memory registry did not).
  hasPendingRetry: (
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
  isWorkday: async (userId, manilaDate) =>
    (await decideDay({ userId, manilaDate })).work,
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
    hasPendingRetryInDb(userId, action, dateStr),
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
    const todayStr = manilaDateString(now);
    const rows = await deps.loadEnabledSchedules();

    for (const row of rows) {
      // The Workday gate owns the whole per-user decision (weekend, holiday,
      // pause window, the user's own day override). A day it says to skip is
      // not a missed run.
      if (!(await deps.isWorkday(row.userId, todayStr))) continue;

      for (const action of ["in", "out"] as const) {
        const timeStr = action === "in" ? row.clockInTime : row.clockOutTime;
        const expected = expectedFireTime(todayStr, timeStr);
        // Grace window absorbs queue wait and a slow HRHub.
        if (now.getTime() < expected.getTime() + config.MISSED_RUN_GRACE_MINUTES * 60 * 1000) {
          continue;
        }

        const hasRun = await deps.hasRunToday(row.userId, action, todayStr, now);
        // A retry is queued: the morning is being handled — a missed-run alert
        // would duplicate the retry messages and train the user to distrust
        // both (phase 14B, now durable across a restart — 15B). Suppress.
        if (
          hasRun ||
          (await deps.hasPendingRetry(row.userId, action, todayStr))
        ) {
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
