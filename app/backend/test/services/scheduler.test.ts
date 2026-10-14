import { describe, it, expect } from "vitest";
import type { Schedule } from "../../src/db/schema";
import { dueSlots } from "../../src/services/scheduler";

// dueSlots is the scheduler's whole timing decision: which Manila slots are due
// at a given wall-clock instant. It replaced node-cron (2026-10-13), whose long
// timers woke late on the drifting host clock and dropped the slot. Since the
// phase-16 review (defect B1) it no longer filters weekends — the Workday gate
// decides work/non-work, so a weekend "work anyway" override can fire.

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
const none = new Set<string>();

describe("dueSlots", () => {
  it("is not due a second before the slot, and due at the slot", () => {
    expect(dueSlots([row()], at("05:29:59"), none, WINDOW_MS)).toEqual([]);
    expect(dueSlots([row()], at("05:30:00"), none, WINDOW_MS)).toEqual([
      {
        userId: "u1",
        action: "in",
        manilaDate: "2026-10-13",
        slot: at("05:30:00"),
      },
    ]);
  });

  it("still fires a slot reached late, up to the fire window (the 2026-10-13 miss)", () => {
    // The node-cron version woke 26 min 48 s late this morning and dropped
    // the slot; with a 20-minute window that lateness is outside, but anything
    // a 15 s tick can produce is well inside.
    expect(dueSlots([row()], at("05:49:59"), none, WINDOW_MS)).toHaveLength(1);
    expect(dueSlots([row()], at("05:50:00"), none, WINDOW_MS)).toEqual([]);
  });

  it("handles the clock-out slot independently", () => {
    const due = dueSlots([row()], at("16:15:10"), none, WINDOW_MS);
    expect(due.map((d) => d.action)).toEqual(["out"]);
  });

  it("never fires a slot already fired today", () => {
    const fired = new Set(["u1::in::2026-10-13"]);
    expect(dueSlots([row()], at("05:30:15"), fired, WINDOW_MS)).toEqual([]);
  });

  it("yields weekend slots by timing, and skips disabled schedules", () => {
    // Sat 2026-10-10, Manila. The weekend decision belongs to the Workday gate
    // (`fireCron`), not to `dueSlots`: a Saturday slot IS due by wall-clock
    // timing, so a "work anyway" override can fire it, and a plain weekend is
    // still silent because the gate says non-work and notifySkip refuses it.
    const saturday = new Date("2026-10-10T05:30:00+08:00");
    expect(dueSlots([row()], saturday, none, WINDOW_MS)).toEqual([
      {
        userId: "u1",
        action: "in",
        manilaDate: "2026-10-10",
        slot: saturday,
      },
    ]);
    expect(
      dueSlots([row({ enabled: false })], at("05:30:00"), none, WINDOW_MS),
    ).toEqual([]);
  });

  it("uses Manila time, not the process timezone", () => {
    // 21:30Z Monday is 05:30 Tuesday in Manila.
    const due = dueSlots(
      [row()],
      new Date("2026-10-12T21:30:00Z"),
      none,
      WINDOW_MS,
    );
    expect(due).toHaveLength(1);
    expect(due[0]!.manilaDate).toBe("2026-10-13");
  });
});
