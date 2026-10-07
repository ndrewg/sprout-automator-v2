import { describe, it, expect, vi, afterEach } from "vitest";
import cron from "node-cron";
import {
  dailyTaskOptions,
  timeToCronExpression,
} from "../../src/services/scheduler";

describe("timeToCronExpression", () => {
  it("converts HH:MM / HH:MM:SS to a Mon–Fri cron expression", () => {
    expect(timeToCronExpression("05:30")).toBe("30 5 * * 1-5");
    expect(timeToCronExpression("18:05:00")).toBe("5 18 * * 1-5");
    expect(timeToCronExpression("00:00")).toBe("0 0 * * 1-5");
    expect(timeToCronExpression("23:59")).toBe("59 23 * * 1-5");
  });

  it("rejects out-of-range / malformed times", () => {
    expect(() => timeToCronExpression("24:00")).toThrow();
    expect(() => timeToCronExpression("5:99")).toThrow();
    expect(() => timeToCronExpression("notatime")).toThrow();
  });
});

// Regression for the misses from 2026-09-14 to 2026-10-07. The wall clock in the
// Docker Desktop VM gains ~57 s/day on the monotonic clock setTimeout uses, so
// a daily node-cron task wakes about a minute late by wall time. Reproduced here
// by jumping the fake system clock ahead WITHOUT advancing the timers.
describe("daily task tolerance to wall-clock drift", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function fireCountWhenWokenLate(
    options: Parameters<typeof cron.schedule>[2],
    lateByMs: number,
  ): Promise<number> {
    vi.useFakeTimers();
    // Mon 2026-10-05 05:29:00 Manila = Sun 21:29:00Z.
    vi.setSystemTime(new Date("2026-10-04T21:29:00.000Z"));
    let fired = 0;
    const task = cron.schedule("30 5 * * 1-5", () => void fired++, options);
    try {
      // The wall clock drifts ahead; the timer still waits its full 60 s.
      vi.setSystemTime(Date.now() + lateByMs);
      await vi.advanceTimersByTimeAsync(60_000);
    } finally {
      void task.stop();
    }
    return fired;
  }

  it("drops the slot with node-cron's default 1000 ms tolerance (the bug)", async () => {
    expect(
      await fireCountWhenWokenLate({ timezone: "Asia/Manila" }, 60_000),
    ).toBe(0);
  });

  it("still fires a slot woken a minute late with dailyTaskOptions()", async () => {
    expect(await fireCountWhenWokenLate(dailyTaskOptions(), 60_000)).toBe(1);
  });
});
