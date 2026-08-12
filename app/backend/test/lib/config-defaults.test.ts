import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";

// The numeric config dials carry their defaults in config.ts (the single source
// of truth — compose deliberately passes no defaults through). These assertions
// pin the parsed defaults so a silent revert is caught, and so the "unset
// behaves like the default" contract is explicit.
//
// loadConfig() reads process.env directly, so each test rewrites it and
// restores it afterwards. The module-level `config` const is loaded once with
// the vitest env and is not touched by these calls.

const savedEnv = { ...process.env };

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(restoreEnv);

describe("config defaults", () => {
  it("AUTH_RATE_LIMIT defaults to 30 (phase 8 §8B)", () => {
    delete process.env["AUTH_RATE_LIMIT"];
    expect(loadConfig().AUTH_RATE_LIMIT).toBe(30);
  });

  it("TRUST_PROXY_HOPS defaults to 1 (phase 8 §8C)", () => {
    delete process.env["TRUST_PROXY_HOPS"];
    expect(loadConfig().TRUST_PROXY_HOPS).toBe(1);
  });
});
