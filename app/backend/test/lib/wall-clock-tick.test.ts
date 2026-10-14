import { afterEach, describe, expect, it, vi } from "vitest";
import {
  manilaHhmm,
  onTick,
  stopWallClockTick,
  TICK_MS,
  wallClockLastTickAt,
} from "../../src/lib/wall-clock-tick";

describe("wall-clock tick", () => {
  afterEach(() => {
    stopWallClockTick();
    vi.useRealTimers();
  });

  it("hands handlers the WALL clock, even when it has run ahead of the timers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T05:29:50+08:00"));
    const seen: Date[] = [];
    onTick("test", (now) => void seen.push(now));
    // The host's failure mode: the wall clock jumps ahead of the monotonic
    // clock timers run on. The next tick must see the jumped wall time.
    const jumped = new Date("2026-10-13T05:56:30+08:00");
    vi.setSystemTime(jumped);
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(seen).toHaveLength(1);
    // The jumped wall time plus the one tick that elapsed.
    expect(seen[0]!.getTime()).toBe(jumped.getTime() + TICK_MS);
    expect(manilaHhmm(seen[0]!)).toBe("05:56");
    expect(wallClockLastTickAt()).toBe(seen[0]!.toISOString());
  });

  it("keeps ticking when a handler throws or rejects", async () => {
    vi.useFakeTimers();
    let calls = 0;
    onTick("throws", () => {
      throw new Error("sync boom");
    });
    onTick("rejects", async () => {
      throw new Error("async boom");
    });
    onTick("counter", () => void calls++);
    await vi.advanceTimersByTimeAsync(TICK_MS * 3);
    expect(calls).toBe(3);
  });
});
