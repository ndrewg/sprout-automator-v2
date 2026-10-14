import {
  NO_CLOCK_IN_SKIP_REASON,
  unknownOutcomeDetail,
  type ClockAttemptOutcome,
} from "../lib/run-outcome";
import type { AttendanceCard } from "./attendance-card";
import type {
  ClockAction,
  ClockPressResult,
  HRHubPortal,
  LoginMethod,
} from "./portal-seam";

// ONE clock attempt, above the portal seam (phase 17 § 17B).
//
// This is the module the whole phase exists for: the app believes HRHub's
// attendance card, not its own click. Before this, "success" meant a dialog
// with the expected title appeared and the card was never read again, so the
// two worst outcomes were both reachable — a double clock (a retry after a
// click that HAD landed) and a clock-out with no clock-in (which happened for
// real on 2026-08-20). Every rule below was previously buried in Playwright
// code that no test could reach.
//
// The order is the contract:
//
//   1. READ the card  — stop on an unreadable card; skip what is already done;
//                       never write half a record (an OUT needs today's IN).
//   2. PRESS          — a throw here means nothing was dispatched: retryable.
//   3. READ it AGAIN  — the ROW decides, whatever the dialog said.
//   4. UNKNOWN        — unconfirmed and invisible is recorded, alerted, and
//                       never auto-retried. Only the row's *absence* plus an
//                       explicit HRHub error is treated as "not done".
//
// It takes an HRHubPortal, so production runs the Playwright adapter and the
// tests run a scripted fake in milliseconds with no Chromium and no HRHub.

/** A short bounded wait for HRHub to repaint the card after the click. */
export const ATTENDANCE_SETTLE_MS = 3000;

export type ClockAttemptResult = {
  outcome: ClockAttemptOutcome;
  loginMethod: LoginMethod;
  /** The success dialog's text, when there was one. */
  message?: string;
  /** Failure reason / the "unknown" detail. Persisted to `runs.error`. */
  error?: string;
  /** Why a skip happened, for the notifier (never a lifecycle step). */
  skipReason?: string;
};

export type ClockAttemptParams = {
  action: ClockAction;
  log?: (message: string) => void;
};

export type ClockAttemptDeps = {
  /** How long to let HRHub settle before the AFTER read. Injectable for tests. */
  settleMs?: number;
};

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A read that throws is an unreadable card, never a thrown run: the guard's
 * whole job is to be conservative, and an exception is the strongest possible
 * signal that we cannot confirm today's state.
 */
async function readCard(
  portal: HRHubPortal,
  settleMs: number,
  log?: (message: string) => void,
): Promise<AttendanceCard> {
  try {
    return await portal.readTodayAttendance(settleMs > 0 ? { settleMs } : {});
  } catch (err: unknown) {
    log?.(`Reading the attendance card failed (${messageOf(err)}).`);
    return {
      readable: false,
      inPresent: false,
      outPresent: false,
      inRow: null,
      outRow: null,
      unreadableReason: `the read threw (${messageOf(err)})`,
    };
  }
}

/** Screenshots are diagnostics: a failure is logged, never fatal (17A). */
async function safeScreenshot(
  portal: HRHubPortal,
  name: string,
  log?: (message: string) => void,
): Promise<void> {
  try {
    await portal.takeScreenshot(name);
  } catch (err: unknown) {
    log?.(`Screenshot ${name} failed (${messageOf(err)}) — continuing.`);
  }
}

function unreadableSkipReason(card: AttendanceCard, label: string): string {
  const why = card.unreadableReason ?? "no reason reported";
  // Phrased to match the notifier's "could not verify" marker
  // (services/notifications.ts): an unreadable card means the user is probably
  // NOT clocked in, which is an alert rather than a reassurance.
  return `Could not read the attendance card (${why}). Skipping ${label} as a safety measure.`;
}

export async function clockAttempt(
  portal: HRHubPortal,
  params: ClockAttemptParams,
  deps: ClockAttemptDeps = {},
): Promise<ClockAttemptResult> {
  const { action, log } = params;
  const label = action === "in" ? "IN" : "OUT";
  const settleMs = deps.settleMs ?? ATTENDANCE_SETTLE_MS;

  // The saved session, the fresh-login recovery and the OTP callback all stay
  // inside the adapter; a login that cannot reach the dashboard still throws
  // out of here, which the executor records as the run's failure.
  const loginMethod = await portal.ensureLoggedIn();

  // --- 1. Read the card BEFORE acting ---------------------------------------
  log?.("Reading the attendance card before acting...");
  const before = await readCard(portal, 0, log);
  await safeScreenshot(portal, `clock-${action}-card-before`, log);

  if (!before.readable) {
    const skipReason = unreadableSkipReason(before, label);
    log?.(skipReason);
    return { outcome: "skipped", loginMethod, skipReason };
  }

  const presentRow = action === "in" ? before.inRow : before.outRow;
  if (presentRow !== null) {
    const skipReason = `Already clocked ${label} today (matched row "${presentRow}") — skipping.`;
    log?.(skipReason);
    return { outcome: "skipped", loginMethod, skipReason };
  }

  if (action === "out" && !before.inPresent) {
    // Never create half a record. The 2026-08-20 anomaly was exactly this: the
    // morning's clock-in failed and the afternoon's clock-out succeeded, leaving
    // an open shift on the day.
    log?.(
      `No IN row for today on the attendance card — not clocking out. ${NO_CLOCK_IN_SKIP_REASON}.`,
    );
    return { outcome: "skipped", loginMethod, skipReason: NO_CLOCK_IN_SKIP_REASON };
  }

  // --- 2. Press the action ---------------------------------------------------
  log?.(`Executing clock ${action.toUpperCase()} action...`);
  let press: ClockPressResult;
  try {
    press = await portal.pressClockAction(action);
  } catch (err: unknown) {
    // Everything up to and including the confirmation dialog. Nothing was
    // dispatched, so this is a plain retryable failure — unchanged from today.
    const error = messageOf(err);
    log?.(`Clock ${label} action failed before the confirmation click: ${error}`);
    return { outcome: "failure", loginMethod, error };
  }

  // --- 3. Read the card AGAIN, and let the ROW decide ------------------------
  log?.("Reading the attendance card again to confirm...");
  const after = await readCard(portal, settleMs, log);
  await safeScreenshot(portal, `clock-${action}-card-after`, log);

  const confirmedRow = after.readable
    ? action === "in"
      ? after.inRow
      : after.outRow
    : null;

  if (confirmedRow !== null) {
    // Whatever the dialog showed, HRHub's own record now carries the row.
    log?.(
      `Clock ${label} verified against the attendance card (row "${confirmedRow}").`,
    );
    return {
      outcome: "success",
      loginMethod,
      ...(press.outcome === "confirmed" && press.message !== null
        ? { message: press.message }
        : {}),
    };
  }

  if (press.outcome === "error_dialog" && after.readable) {
    // HRHub said no, and its own card agrees that nothing was recorded.
    log?.(
      `HRHub reported an error and the card shows no ${label} row: ${press.error}`,
    );
    return { outcome: "failure", loginMethod, error: press.error };
  }

  // --- 4. Unknown ------------------------------------------------------------
  // No confirmation and no row, or a card we cannot read: the click may or may
  // not have landed. Recorded, alerted, NEVER auto-retried — a retry here is a
  // second clock against a day whose state we do not know.
  const detail = unknownOutcomeDetail();
  log?.(
    `Clock ${label} state unknown: the card shows no ${label} row and HRHub did not confirm (${press.outcome}).`,
  );
  return { outcome: "unknown", loginMethod, error: detail };
}
