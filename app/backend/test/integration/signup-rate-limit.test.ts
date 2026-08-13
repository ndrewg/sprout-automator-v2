import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config";
import {
  parseTrustedCloudflarePeers,
  setTrustedCloudflarePeers,
} from "../../src/middleware/security";
import {
  closeTestServer,
  request,
  resetDatabase,
  setupDatabase,
  startTestServer,
} from "./harness";

// One file, one budget-draining test: the authLimiter's in-memory store is per
// module registry, and the loop below exhausts the whole /auth/signup budget.
// The loop bound is derived from config.AUTH_RATE_LIMIT rather than hardcoded,
// so the property under test is "the budget is enforced", not "the number is
// 30" — the next default change must not break this file again.

const AUTH_LIMIT = config.AUTH_RATE_LIMIT;

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

  it("the request past the auth budget is 429, so the allowlist cannot be probed by brute force", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < AUTH_LIMIT + 1; i++) {
      const res = await request("/auth/signup", {
        method: "POST",
        body: { email: `ratelimit-probe-${i}@evil.com`, password: "rate-limit-pass-1234" },
      });
      statuses.push(res.status);
    }
    // The first AUTH_LIMIT reach the allowlist gate and are rejected; the
    // (AUTH_LIMIT+1)th is stopped by authLimiter BEFORE the route runs.
    expect(statuses.slice(0, AUTH_LIMIT)).toEqual(Array(AUTH_LIMIT).fill(403));
    expect(statuses[AUTH_LIMIT]).toBe(429);
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
      ).toBe(`${AUTH_LIMIT};w=900`);
    }
  });

  // Phase 8 §8C, corrected per the B1 review finding: authLimiter keys on
  // clientIp, which honours CF-Connecting-IP ONLY when the socket peer is a
  // trusted Cloudflare tunnel peer — and no tunnel exists, so the trusted set
  // is empty and a client-supplied header is ignored. The property the gate
  // exists for: an attacker cannot rotate a forged CF-Connecting-IP to get a
  // fresh budget (evasion), nor claim a victim's address to fill their bucket
  // (poisoning) — every request from an untrusted peer keys on the same req.ip
  // (here: the harness's own connection), so alice's spending throttles bob no
  // matter what header either sends.
  it("auth budget ignores a spoofed CF-Connecting-IP from an untrusted peer: rotating the header cannot evade the budget", async () => {
    const alice = "198.51.100.10";
    const bob = "198.51.100.20";
    const signup = (ip: string, i: number) =>
      request("/auth/signup", {
        method: "POST",
        headers: { "CF-Connecting-IP": ip },
        body: {
          email: `cf-keying-${ip}-${i}@evil.com`,
          password: "rate-limit-pass-1234",
        },
      });

    // Exhaust the real bucket (the harness's req.ip) using alice's header:
    // every request reaches the allowlist gate (403, evil.com is not allowed)
    // and consumes one unit of the shared budget.
    for (let i = 0; i < AUTH_LIMIT; i++) {
      const res = await signup(alice, i);
      expect(res.status, `alice request ${i}`).toBe(403);
    }
    // A DIFFERENT spoofed header is STILL the same bucket — the header is
    // ignored, so bob is throttled by alice's spending (no evasion).
    const bobRes = await signup(bob, AUTH_LIMIT);
    expect(bobRes.status).toBe(429);
    // And alice's own header is likewise exhausted (same shared bucket).
    const aliceAgain = await signup(alice, AUTH_LIMIT + 1);
    expect(aliceAgain.status).toBe(429);
  });

  // The same property on the trusted-tunnel path: when the socket peer IS a
  // trusted Cloudflare tunnel peer, CF-Connecting-IP is honoured, so different
  // values get different buckets — the property that motivated the header in
  // the first place. The harness's beforeEach resetDatabase() also resets the
  // trusted-peer set to the empty default (resetRateLimits), so this test's
  // trust is scoped to itself and must be re-applied after each reset.
  it("auth budget honours CF-Connecting-IP from a trusted tunnel peer: different clients do not share a bucket, the same client does", async () => {
    setTrustedCloudflarePeers(parseTrustedCloudflarePeers("127.0.0.1"));
    const alice = "198.51.100.10";
    const bob = "198.51.100.20";
    const signup = (ip: string, i: number) =>
      request("/auth/signup", {
        method: "POST",
        headers: { "CF-Connecting-IP": ip },
        body: {
          email: `cf-keying-${ip}-${i}@evil.com`,
          password: "rate-limit-pass-1234",
        },
      });

    // Exhaust alice's bucket: every request reaches the allowlist gate (403,
    // evil.com is not allowed) and consumes one unit of alice's budget.
    for (let i = 0; i < AUTH_LIMIT; i++) {
      const res = await signup(alice, i);
      expect(res.status, `alice request ${i}`).toBe(403);
    }
    // A different CF-Connecting-IP is a different bucket — bob is NOT
    // throttled by alice's spending, so his request still reaches the gate.
    const bobRes = await signup(bob, AUTH_LIMIT);
    expect(bobRes.status).toBe(403);
    // The same CF-Connecting-IP is the same bucket — alice is exhausted.
    const aliceAgain = await signup(alice, AUTH_LIMIT + 1);
    expect(aliceAgain.status).toBe(429);
  });
});
