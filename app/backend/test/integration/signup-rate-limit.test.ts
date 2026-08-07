import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeTestServer,
  request,
  resetDatabase,
  setupDatabase,
  startTestServer,
} from "./harness";

// One test, one file: the authLimiter's in-memory store is per module registry,
// and this test exhausts the whole 10/15min budget for /auth/signup. Any other
// signup request in this file (or any file sharing this store) would break the
// "the 11th is 429" arithmetic.

describe("signup brute-force probing", () => {
  beforeAll(async () => {
    await setupDatabase();
    await startTestServer();
  });
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await closeTestServer();
  });

  it("the 11th rapid signup attempt is 429, so the allowlist cannot be probed by brute force", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await request("/auth/signup", {
        method: "POST",
        body: { email: `ratelimit-probe-${i}@evil.com`, password: "rate-limit-pass-1234" },
      });
      statuses.push(res.status);
    }
    // The first 10 reach the allowlist gate and are rejected; the 11th is
    // stopped by authLimiter BEFORE the route runs.
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(403));
    expect(statuses[10]).toBe(429);
  });

  // The reset endpoints are unauthenticated and in the same family as login:
  // forgot-password sends email (mailbox flooding, account probing) and
  // reset-password takes an unauthenticated token. Asserting on the authLimiter
  // headers rather than exhausting a second budget is deliberate: authLimiter is
  // ONE instance shared by every path it is mounted on, and the integration
  // project runs single-fork, so a second budget-draining test would collide
  // with the one above. Header presence proves the limiter ran, whatever order
  // the files execute in.
  it("the reset endpoints are covered by authLimiter", async () => {
    for (const path of ["/auth/forgot-password", "/auth/reset-password"]) {
      const res = await request(path, { method: "POST", body: {} });
      expect(
        res.headers.get("ratelimit-policy"),
        `${path} is not rate limited — an unauthenticated endpoint that sends mail or accepts a token must be`,
      ).toBe("10;w=900");
    }
  });
});
