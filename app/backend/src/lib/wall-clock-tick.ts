import { logger } from "./logger";

// The process-wide wall-clock tick (2026-10-13, replaces node-cron — see D8).
//
// Every time-of-day job in this app (the daily clock-in/out slots, one-shot
// retries, the missed-run sweep, the nightly Gazette refresh) is driven from
// ONE short setInterval that compares the wall clock against what is due.
// Nothing sleeps on a long timer.
//
// Why: on the scheduled host (Docker Desktop's WSL2 VM) the monotonic clock
// that setTimeout/setInterval run on drifts badly against the NTP-synced wall
// clock — measured at ~57 s/day on 2026-10-07 and ~450 s/day on 2026-10-13,
// varying hour to hour. node-cron v4 slept on one timer per slot (up to 24 h)
// and dropped any slot woken more than its tolerance late, so the 05:30 run
// was silently skipped. A short tick bounds the drift per wait to a fraction
// of a second, and because each consumer compares against `new Date()`, a late
// tick only delays a job; it can never skip one.

export const TICK_MS = 15_000;

type TickHandler = (now: Date) => void | Promise<void>;

const handlers = new Map<string, TickHandler>();
let timer: ReturnType<typeof setInterval> | undefined;
let lastTickAt: string | null = null;

// Never lets one consumer's failure (sync throw or rejection) stop the others
// or the interval.
async function runHandler(
  name: string,
  handler: TickHandler,
  now: Date,
): Promise<void> {
  try {
    await handler(now);
  } catch (err: unknown) {
    logger.error({ err, handler: name }, "tick handler failed");
  }
}

function tick(): void {
  const now = new Date();
  lastTickAt = now.toISOString();
  for (const [name, handler] of handlers) {
    void runHandler(name, handler, now);
  }
}

/**
 * Register (or replace) a named handler, called on every tick with the current
 * wall-clock instant. Starts the shared interval on first use. The interval is
 * unref'd: the HTTP server keeps production alive, and a test process must be
 * able to exit.
 */
export function onTick(name: string, handler: TickHandler): void {
  handlers.set(name, handler);
  if (!timer) {
    timer = setInterval(tick, TICK_MS);
    timer.unref();
  }
}

/** ISO instant of the last tick, for /health. NULL until the first tick. */
export function wallClockLastTickAt(): string | null {
  return lastTickAt;
}

/** Test hook: stop the interval and drop every handler. */
export function stopWallClockTick(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  handlers.clear();
}

const hhmmFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Manila",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** "HH:mm" in Asia/Manila for an instant. */
export function manilaHhmm(dt: Date): string {
  return hhmmFmt.format(dt);
}
