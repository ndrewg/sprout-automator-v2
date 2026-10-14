import type { AttendanceCard } from "../../src/automation/attendance-card";
import type {
  ClockAction,
  ClockPressResult,
  HRHubPortal,
  LoginMethod,
} from "../../src/automation/portal-seam";

// A scripted HRHub portal (phase 17 § 17A): the second adapter that justifies
// the seam. It plays a fixed sequence of card states and one press result, so
// the orchestration's safety rules run in milliseconds with no Chromium, no
// network and no HRHub — which is what makes "read the card before acting",
// "an OUT needs today's IN" and "unconfirmed means unknown" testable at all.
//
// Test-only by construction: it lives under test/, so playwright is never
// imported by anything the production graph loads.

export type ScriptedPortal = HRHubPortal & {
  readCount: () => number;
  pressCount: () => number;
  pressedActions: ClockAction[];
  screenshotNames: string[];
  /** The `settleMs` handed to each read, in order. */
  settleWaits: number[];
  isClosed: () => boolean;
};

export type ScriptedPortalOptions = {
  loginMethod?: LoginMethod;
  /** Thrown by ensureLoggedIn when set (a login that cannot reach HRHub). */
  loginError?: Error;
  /**
   * Cards returned by successive reads. The LAST card is returned for every
   * further read, so two entries mean "before" and "after" — which is how the
   * re-read after the click is scripted.
   */
  cards?: AttendanceCard[];
  /** What the press does. An `Error` models a failure BEFORE the click. */
  press?: ClockPressResult | Error;
  /** Thrown by takeScreenshot when set (the I/O failure 17A must swallow). */
  screenshotError?: Error;
};

/** A readable card with nothing on it for today. */
export function readableCard(
  overrides: Partial<AttendanceCard> = {},
): AttendanceCard {
  return {
    readable: true,
    inPresent: false,
    outPresent: false,
    inRow: null,
    outRow: null,
    unreadableReason: null,
    ...overrides,
  };
}

/** An unreadable card — HRHub changed its format, or there is no card. */
export function unreadableCard(reason = "no card"): AttendanceCard {
  return {
    readable: false,
    inPresent: false,
    outPresent: false,
    inRow: null,
    outRow: null,
    unreadableReason: reason,
  };
}

export function scriptedPortal(
  options: ScriptedPortalOptions = {},
): ScriptedPortal {
  const cards = options.cards ? [...options.cards] : [readableCard()];
  const pressedActions: ClockAction[] = [];
  const screenshotNames: string[] = [];
  const settleWaits: number[] = [];
  let reads = 0;
  let presses = 0;
  let closed = false;
  const loginMethod = options.loginMethod ?? "saved_session";

  return {
    async ensureLoggedIn(): Promise<LoginMethod> {
      if (options.loginError) throw options.loginError;
      return loginMethod;
    },

    async readTodayAttendance(readOptions): Promise<AttendanceCard> {
      settleWaits.push(readOptions?.settleMs ?? 0);
      reads += 1;
      const next =
        cards.length > 1 ? cards.shift() : cards.length === 1 ? cards[0] : undefined;
      if (!next) throw new Error("scripted portal: no card scripted");
      return next;
    },

    async pressClockAction(action: ClockAction): Promise<ClockPressResult> {
      presses += 1;
      pressedActions.push(action);
      const press = options.press ?? { outcome: "no_dialog" };
      if (press instanceof Error) throw press;
      return press;
    },

    async takeScreenshot(name: string): Promise<void> {
      if (options.screenshotError) throw options.screenshotError;
      screenshotNames.push(name);
    },

    async close(): Promise<void> {
      closed = true;
    },

    readCount: () => reads,
    pressCount: () => presses,
    pressedActions,
    screenshotNames,
    settleWaits,
    isClosed: () => closed,
  };
}
