import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, schedulerEnabled } from "../../src/config";
import { startScheduler } from "../../src/services/scheduler";
import { stopWallClockTick, tickHandlerNames } from "../../src/lib/wall-clock-tick";

// Phase 15D — one host schedules. `SCHEDULER_ENABLED` is a boolean that defaults
// to FALSE, and a value that is neither "true" nor "false" refuses to boot
// rather than silently disabling the host that does the clocking.
//
// loadConfig() reads process.env directly, so each test rewrites it and restores
// it afterwards. The module-level `config` const is loaded once with the vitest
// env and is not touched by these calls.

const savedEnv = { ...process.env };

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  stopWallClockTick();
  restoreEnv();
});

describe("config: SCHEDULER_ENABLED", () => {
  it("defaults to false — a machine must opt in to clocking anyone", () => {
    delete process.env["SCHEDULER_ENABLED"];
    expect(loadConfig().SCHEDULER_ENABLED).toBe(false);
  });

  it("an empty string (the compose passthrough) resolves to the default false", () => {
    process.env["SCHEDULER_ENABLED"] = "";
    expect(loadConfig().SCHEDULER_ENABLED).toBe(false);
  });

  it("parses the two literal values it accepts", () => {
    process.env["SCHEDULER_ENABLED"] = "true";
    expect(loadConfig().SCHEDULER_ENABLED).toBe(true);
    process.env["SCHEDULER_ENABLED"] = "false";
    expect(loadConfig().SCHEDULER_ENABLED).toBe(false);
  });

  it("refuses to boot on a malformed value, naming the key and what it wanted", () => {
    process.env["SCHEDULER_ENABLED"] = "yes";
    expect(() => loadConfig()).toThrow(/SCHEDULER_ENABLED/);
    expect(() => loadConfig()).toThrow(/true|false/);
    process.env["SCHEDULER_ENABLED"] = "1";
    expect(() => loadConfig()).toThrow(/SCHEDULER_ENABLED/);
  });
});

describe("schedulerEnabled()", () => {
  it("falls back to the config default when the key is unset or empty", () => {
    delete process.env["SCHEDULER_ENABLED"];
    expect(schedulerEnabled()).toBe(false);
    process.env["SCHEDULER_ENABLED"] = "";
    expect(schedulerEnabled()).toBe(false);
  });

  it("honours an explicit value (so a boot can be checked without re-loading config)", () => {
    process.env["SCHEDULER_ENABLED"] = "true";
    expect(schedulerEnabled()).toBe(true);
    process.env["SCHEDULER_ENABLED"] = "false";
    expect(schedulerEnabled()).toBe(false);
  });
});

describe("arming the tick", () => {
  it("registers nothing until a scheduler is started", () => {
    expect(tickHandlerNames()).toEqual([]);
  });

  it("startScheduler arms the slot tick and the retry trigger on the shared tick", () => {
    startScheduler();
    expect(tickHandlerNames()).toEqual(
      expect.arrayContaining(["scheduler", "retries"]),
    );
  });
});
