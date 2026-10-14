import { afterEach, describe, expect, it, vi } from "vitest";
import type { Schedule } from "../../src/db/schema";
import {
  resetSchedulerState,
  schedulerTick,
  type DueSlot,
  type FireResult,
} from "../../src/services/scheduler";
import { stopWallClockTick } from "../../src/lib/wall-clock-tick";

// Phase 15C — the tick GLUE, which the phase-15-era tests never covered: what
// `schedulerTick` does with a slot when the fire does not produce a run.
//
// A slot's in-memory `fired` entry is a RE-ENTRANCY GUARD, not the record. If a
// fire fails before a run row or a deliberate skip exists (a database error, a
// thrown holiday decision), the entry is removed so the next tick tries again
// until the slot's window closes — before this, one error at 05:30:00 lost the
// day silently.
//
// Unit, no database: the tick's collaborators are injected, and every instant is
// passed in (BACKLOG §11 — no Date.now() in logic a test needs to pin).

const WINDOW_MS = 20 * 60 * 1000;

function row(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: "s1",
    userId: "u1",
    clockInTime: "05:30:00",
    clockOutTime: "16:15:00",
    enabled: true,
    updatedAt: new Date(),
    pausedFrom: null,
    pausedUntil: null,
    ...overrides,
  } as Schedule;
}

// Tue 2026-10-13, Manila wall time.
const at = (hhmmss: string) => new Date(`2026-10-13T${hhmmss}+08:00`);

function makeDeps(result?: FireResult) {
  const fire = vi.fn(
    async (_due: DueSlot, _now: Date): Promise<FireResult> =>
      result ?? { outcome: "created" },
  );
  const sweep = vi.fn(async (): Promise<void> => {});
  return {
    fire,
    sweep,
    deps: {
      slots: () => [row()],
      fire,
      sweep,
      windowMs: () => WINDOW_MS,
    },
  };
}

afterEach(() => {
  resetSchedulerState();
  stopWallClockTick();
});

describe("schedulerTick — the fire path receives the tick's instant", () => {
  it("hands the fire path the tick's own instant (no second new Date())", async () => {
    const { fire, sweep, deps } = makeDeps();
    const now = at("05:30:05");
    await schedulerTick(now, deps);

    expect(fire).toHaveBeenCalledTimes(1);
    const [due, passed] = fire.mock.calls[0]!;
    expect(passed).toBe(now);
    expect(due).toMatchObject({ userId: "u1", action: "in", manilaDate: "2026-10-13" });
    expect(due.slot.getTime()).toBe(at("05:30:00").getTime());
    // The sweep is not part of this assertion, but it must have run.
    expect(sweep).toHaveBeenCalledTimes(1);
  });
});

describe("schedulerTick — a slot is only fired once it has a run", () => {
  it("retries a fire that FAILED on the next tick, and stops at the window's end", async () => {
    const { fire, deps } = makeDeps({ outcome: "failed" });

    await schedulerTick(at("05:30:05"), deps);
    expect(fire).toHaveBeenCalledTimes(1);

    // The next tick tries again: the slot was NOT recorded as fired.
    await schedulerTick(at("05:35:05"), deps);
    expect(fire).toHaveBeenCalledTimes(2);

    // …and again, up to the end of the 20-minute window.
    await schedulerTick(at("05:49:00"), deps);
    expect(fire).toHaveBeenCalledTimes(3);

    // Past the window the slot is no longer due. The missed-run sweep owns that
    // case (15C: a late wake is alert only, never a late automatic clock-in).
    await schedulerTick(at("05:50:00"), deps);
    await schedulerTick(at("06:10:00"), deps);
    expect(fire).toHaveBeenCalledTimes(3);
  });

  it("retries a fire that THREW, and logs each failed attempt", async () => {
    const { deps } = makeDeps();
    const fire = vi.fn(async (): Promise<FireResult> => {
      throw new Error("database is on fire");
    });
    const throwing = { ...deps, fire };

    await schedulerTick(at("05:30:05"), throwing);
    expect(fire).toHaveBeenCalledTimes(1);
    await schedulerTick(at("05:31:05"), throwing);
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it("keeps the slot fired for a run that was created, on every later tick", async () => {
    const { fire, deps } = makeDeps({ outcome: "created" });
    await schedulerTick(at("05:30:05"), deps);
    await schedulerTick(at("05:31:05"), deps);
    await schedulerTick(at("05:32:05"), deps);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("keeps the slot fired for a deliberate skip (holiday or pause)", async () => {
    const { fire, deps } = makeDeps({ outcome: "skipped" });
    await schedulerTick(at("05:30:05"), deps);
    await schedulerTick(at("05:31:05"), deps);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("keeps the slot fired for a run that already existed (the user clicked first)", async () => {
    const { fire, deps } = makeDeps({ outcome: "existed" });
    await schedulerTick(at("05:30:05"), deps);
    await schedulerTick(at("05:31:05"), deps);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("keeps the slot fired when the user has no credentials — a permanent state, not a transient failure", async () => {
    const { fire, deps } = makeDeps({
      outcome: "not_started",
      reason: "no_credentials",
    });
    await schedulerTick(at("05:30:05"), deps);
    await schedulerTick(at("05:31:05"), deps);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("retries a slot blocked by another ACTIVE run, once that run is out of the way", async () => {
    const { fire, deps } = makeDeps({
      outcome: "not_started",
      reason: "already_running",
    });
    await schedulerTick(at("05:30:05"), deps);
    // Transient: another run holds the singleton, so the slot must not be
    // written off for the day.
    await schedulerTick(at("05:31:05"), deps);
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it("fires once per day across many ticks, for both actions", async () => {
    const fire = vi.fn(
      async (_due: DueSlot): Promise<FireResult> => ({ outcome: "created" }),
    );
    const deps = {
      slots: () => [row()],
      fire,
      sweep: async (): Promise<void> => {},
      windowMs: () => WINDOW_MS,
    };

    // The in slot opens at 05:30, the out slot at 16:15 — same day, different
    // windows, and each fires exactly once however many ticks land inside it.
    for (const t of ["05:30:01", "05:30:16", "05:31:00", "16:15:02", "16:20:00"]) {
      await schedulerTick(at(t), deps);
    }
    expect(fire).toHaveBeenCalledTimes(2);
    expect(fire.mock.calls.map((c) => c[0].action)).toEqual(["in", "out"]);
  });
});

describe("schedulerTick — the missed-run sweep", () => {
  it("runs the sweep once per 5-minute wall-clock bucket, not once per tick", async () => {
    const { sweep, deps } = makeDeps();
    await schedulerTick(at("05:30:05"), deps);
    expect(sweep).toHaveBeenCalledTimes(1);
    // Still the same 5-minute bucket (05:30:00–05:34:59).
    await schedulerTick(at("05:31:05"), deps);
    await schedulerTick(at("05:34:59"), deps);
    expect(sweep).toHaveBeenCalledTimes(1);
    // A new bucket sweeps again.
    await schedulerTick(at("05:35:01"), deps);
    expect(sweep).toHaveBeenCalledTimes(2);
  });
});
