import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { heartbeatConfigured, pingHeartbeat } from "../../src/lib/heartbeat";

// 12D — dead-man's-switch heartbeat. Unit tests for the fire-and-forget ping:
// off when unset, exactly one request when set, no identifying data in the
// request, and a rejecting/hanging endpoint never throws.
// 18D — and `heartbeatConfigured()`, the boolean /health reports: it must track
// whether a ping WOULD be sent, and must never be the URL itself.

describe("pingHeartbeat", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["HEARTBEAT_URL"];
  });

  it("makes zero requests when HEARTBEAT_URL is unset", () => {
    delete process.env["HEARTBEAT_URL"];
    pingHeartbeat();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pings the configured URL exactly once when set", () => {
    process.env["HEARTBEAT_URL"] = "https://heartbeat.example/ping";
    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
    pingHeartbeat();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://heartbeat.example/ping");
    expect(init.method).toBe("GET");
  });

  it("carries no identifying data — no query string, no body, no headers beyond the default", () => {
    process.env["HEARTBEAT_URL"] = "https://heartbeat.example/ping";
    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
    pingHeartbeat();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // No query string means no place for an email/user/run id to hide.
    expect(url).toBe("https://heartbeat.example/ping");
    expect(url).not.toMatch(/[?&]/);
    expect(init.body).toBeUndefined();
    // A GET with no body and no user-supplied headers — nothing identifying.
    expect(init.headers).toBeUndefined();
  });

  it("never throws when the endpoint rejects (fire-and-forget)", async () => {
    process.env["HEARTBEAT_URL"] = "https://heartbeat.example/ping";
    fetchMock.mockRejectedValue(new Error("connection refused"));
    // pingHeartbeat returns void synchronously; the rejection is swallowed by
    // the internal .catch(() => {}). It must not become an unhandled rejection.
    expect(() => pingHeartbeat()).not.toThrow();
    // Give the microtask queue a chance to settle the rejection handler.
    await new Promise((r) => setTimeout(r, 10));
  });

  it("never throws when the endpoint hangs (AbortSignal.timeout aborts)", async () => {
    process.env["HEARTBEAT_URL"] = "https://heartbeat.example/ping";
    // Simulate a hang: never resolve, honoring the abort signal by rejecting.
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    expect(() => pingHeartbeat()).not.toThrow();
    await new Promise((r) => setTimeout(r, 30));
  });
});

// 18D — what /health reports. The endpoint is unauthenticated, so this must be
// a boolean and never the URL.
describe("heartbeatConfigured", () => {
  const fetchMock = vi.fn();
  // A URL that is recognisable enough that leaking ANY part of it is visible.
  const CONFIGURED_URL = "https://hc-ping.com/18d-secret-uuid-heartbeat";

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["HEARTBEAT_URL"];
  });

  it("is false when HEARTBEAT_URL is unset", () => {
    delete process.env["HEARTBEAT_URL"];
    expect(heartbeatConfigured()).toBe(false);
  });

  it("is true when HEARTBEAT_URL is set", () => {
    process.env["HEARTBEAT_URL"] = CONFIGURED_URL;
    expect(heartbeatConfigured()).toBe(true);
  });

  it("returns a boolean and never the URL or any part of it", () => {
    process.env["HEARTBEAT_URL"] = CONFIGURED_URL;
    const value = heartbeatConfigured();
    expect(typeof value).toBe("boolean");
    const asText = JSON.stringify({ configured: value });
    expect(asText).not.toContain("hc-ping.com");
    expect(asText).not.toContain("18d-secret-uuid-heartbeat");
    expect(asText).not.toContain(CONFIGURED_URL);
  });

  it("agrees with whether a ping would actually be sent", () => {
    // Unset: reported off AND nothing pinged.
    delete process.env["HEARTBEAT_URL"];
    expect(heartbeatConfigured()).toBe(false);
    pingHeartbeat();
    expect(fetchMock).toHaveBeenCalledTimes(0);

    // Set: reported on AND exactly one ping. A monitor reading `configured`
    // can therefore never be told "on" while the app stays silent.
    process.env["HEARTBEAT_URL"] = CONFIGURED_URL;
    expect(heartbeatConfigured()).toBe(true);
    pingHeartbeat();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
