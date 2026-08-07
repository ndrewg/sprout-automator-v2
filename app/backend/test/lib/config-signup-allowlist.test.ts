import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";

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

describe("config: SIGNUP_ALLOWED in production", () => {
  it("refuses to start when SIGNUP_ALLOWED is unset", () => {
    process.env["NODE_ENV"] = "production";
    delete process.env["SIGNUP_ALLOWED"];
    expect(() => loadConfig()).toThrow(/SIGNUP_ALLOWED/);
  });

  it("refuses to start when SIGNUP_ALLOWED is an empty string", () => {
    process.env["NODE_ENV"] = "production";
    process.env["SIGNUP_ALLOWED"] = "";
    expect(() => loadConfig()).toThrow(/SIGNUP_ALLOWED/);
  });

  it("refuses to start when SIGNUP_ALLOWED contains only separators", () => {
    process.env["NODE_ENV"] = "production";
    process.env["SIGNUP_ALLOWED"] = " , , ";
    expect(() => loadConfig()).toThrow(/SIGNUP_ALLOWED/);
  });

  it("starts when SIGNUP_ALLOWED lists at least one address or domain", () => {
    process.env["NODE_ENV"] = "production";
    process.env["SIGNUP_ALLOWED"] = "orchard.com.au";
    expect(() => loadConfig()).not.toThrow();
  });
});

describe("config: SIGNUP_ALLOWED outside production", () => {
  it("development without SIGNUP_ALLOWED starts (signup open)", () => {
    process.env["NODE_ENV"] = "development";
    delete process.env["SIGNUP_ALLOWED"];
    expect(() => loadConfig()).not.toThrow();
  });

  it("test without SIGNUP_ALLOWED starts (signup open)", () => {
    process.env["NODE_ENV"] = "test";
    delete process.env["SIGNUP_ALLOWED"];
    expect(() => loadConfig()).not.toThrow();
  });
});
