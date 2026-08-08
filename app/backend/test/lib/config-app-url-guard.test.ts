import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";

// loadConfig() reads process.env directly, so each test rewrites it and
// restores it afterwards. The module-level `config` const is loaded once with
// the vitest env and is not touched by these calls.
//
// The tests set SIGNUP_ALLOWED whenever NODE_ENV=production so the signup
// allowlist guard (4A.2) stays out of the way and the APP_URL guard (5.4b) is
// the only production guard under test.

const savedEnv = { ...process.env };

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(restoreEnv);

describe("config: APP_URL in production", () => {
  it("refuses to start when APP_URL host is localhost", () => {
    process.env["NODE_ENV"] = "production";
    process.env["SIGNUP_ALLOWED"] = "orchard.com.au";
    process.env["APP_URL"] = "http://localhost:3000";
    expect(() => loadConfig()).toThrow(/APP_URL/);
  });

  it("refuses to start when APP_URL host is 127.0.0.1", () => {
    process.env["NODE_ENV"] = "production";
    process.env["SIGNUP_ALLOWED"] = "orchard.com.au";
    process.env["APP_URL"] = "https://127.0.0.1:3000";
    expect(() => loadConfig()).toThrow(/APP_URL/);
  });

  it("refuses to start when APP_URL defaults to localhost", () => {
    process.env["NODE_ENV"] = "production";
    process.env["SIGNUP_ALLOWED"] = "orchard.com.au";
    delete process.env["APP_URL"];
    expect(() => loadConfig()).toThrow(/APP_URL/);
  });

  it("starts when APP_URL host is a real domain", () => {
    process.env["NODE_ENV"] = "production";
    process.env["SIGNUP_ALLOWED"] = "orchard.com.au";
    process.env["APP_URL"] = "https://sprout.yourdomain.com";
    expect(() => loadConfig()).not.toThrow();
  });
});

describe("config: APP_URL outside production", () => {
  it("development allows a localhost APP_URL", () => {
    process.env["NODE_ENV"] = "development";
    delete process.env["SIGNUP_ALLOWED"];
    process.env["APP_URL"] = "http://localhost:3000";
    expect(() => loadConfig()).not.toThrow();
  });

  it("test allows a localhost APP_URL", () => {
    process.env["NODE_ENV"] = "test";
    delete process.env["SIGNUP_ALLOWED"];
    process.env["APP_URL"] = "http://localhost:3000";
    expect(() => loadConfig()).not.toThrow();
  });
});
