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

  // Compose interpolates an unset ${KEY:-} to the empty string, so "unset" and
  // "empty" must be the same thing to config.ts — an empty value must resolve
  // to the documented default, never to 0 (z.coerce.number() would) and never
  // to a validation error. These pin the phase-8 preprocess contract; the live
  // Docker boot checks are the end-to-end proof.
  it("an empty-string AUTH_RATE_LIMIT resolves to the default 30, not 0", () => {
    process.env["AUTH_RATE_LIMIT"] = "";
    expect(loadConfig().AUTH_RATE_LIMIT).toBe(30);
  });

  it("an empty-string MAX_CONCURRENT_RUNS resolves to the default 3, not 0", () => {
    process.env["MAX_CONCURRENT_RUNS"] = "";
    expect(loadConfig().MAX_CONCURRENT_RUNS).toBe(3);
  });

  it("an empty-string TRUST_PROXY_HOPS resolves to the default 1, not 0", () => {
    process.env["TRUST_PROXY_HOPS"] = "";
    expect(loadConfig().TRUST_PROXY_HOPS).toBe(1);
  });

  it("TRUSTED_CLOUDFLARE_PEERS defaults to unset (gate off — see client-ip.test.ts)", () => {
    delete process.env["TRUSTED_CLOUDFLARE_PEERS"];
    expect(loadConfig().TRUSTED_CLOUDFLARE_PEERS).toBeUndefined();
  });
});
