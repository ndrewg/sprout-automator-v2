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
});
