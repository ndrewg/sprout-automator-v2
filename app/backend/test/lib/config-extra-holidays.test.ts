import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";

// 13A — EXTRA_HOLIDAYS must refuse to boot on a malformed entry, exactly like
// TRUSTED_CLOUDFLARE_PEERS / SIGNUP_ALLOWED (the "parse, validate, and refuse"
// stance). An unset/empty value behaves exactly like today (no overrides).

const savedEnv = { ...process.env };

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(restoreEnv);

describe("config: EXTRA_HOLIDAYS (phase 13A)", () => {
  it("is undefined when unset — today's behaviour", () => {
    delete process.env["EXTRA_HOLIDAYS"];
    expect(loadConfig().EXTRA_HOLIDAYS).toBeUndefined();
  });

  it("is undefined for an empty string (Compose's ${EXTRA_HOLIDAYS:-})", () => {
    process.env["EXTRA_HOLIDAYS"] = "";
    expect(loadConfig().EXTRA_HOLIDAYS).toBeUndefined();
  });

  it("starts with a valid override entry", () => {
    process.env["EXTRA_HOLIDAYS"] = "2026-11-20=Special Holiday";
    expect(() => loadConfig()).not.toThrow();
    expect(loadConfig().EXTRA_HOLIDAYS).toBe("2026-11-20=Special Holiday");
  });

  it("refuses to boot on a non-real calendar date (2026-02-31), naming the key and position", () => {
    process.env["EXTRA_HOLIDAYS"] = "2026-02-31=Nope";
    expect(() => loadConfig()).toThrow(/EXTRA_HOLIDAYS/);
    expect(() => loadConfig()).toThrow(/entry 1/);
    expect(() => loadConfig()).toThrow(/not a real calendar date/);
  });

  it("refuses to boot on a missing = , naming the key and position", () => {
    process.env["EXTRA_HOLIDAYS"] = "2026-11-20 Special Holiday";
    expect(() => loadConfig()).toThrow(/EXTRA_HOLIDAYS/);
    expect(() => loadConfig()).toThrow(/entry 1/);
  });

  it("refuses to boot on a malformed SECOND entry, naming its position", () => {
    process.env["EXTRA_HOLIDAYS"] = "2026-11-20=Good, 2026-02-31=Nope";
    expect(() => loadConfig()).toThrow(/entry 2/);
  });
});
