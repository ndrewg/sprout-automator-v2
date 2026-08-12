import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Request } from "express";
import {
  clientIp,
  setTrustedCloudflarePeers,
} from "../../src/middleware/security";

// clientIp is the rate-limit key, so the whole class of "a spoofable header
// merges every client into one bucket" bugs lives or dies here. The ONLY
// channel on which CF-Connecting-IP is trusted is a real Cloudflare Tunnel,
// which no deployment has — so the default trusted-peer set is EMPTY and a
// client-supplied header is ignored no matter how well-formed it is. The only
// Request surface it reads is headers / ip / socket.remoteAddress, which a
// minimal cast covers.

function mockReq(
  headers: Record<string, string | string[] | undefined>,
  ip: string | undefined,
  remoteAddress: string | undefined,
): Request {
  return { headers, ip, socket: { remoteAddress } } as unknown as Request;
}

describe("clientIp", () => {
  beforeEach(() => setTrustedCloudflarePeers(new Set()));
  afterEach(() => setTrustedCloudflarePeers(new Set()));

  it("ignores CF-Connecting-IP from an untrusted peer even when it is a valid IPv4 literal", () => {
    const req = mockReq({ "cf-connecting-ip": "198.51.100.7" }, "127.0.0.1", "127.0.0.1");
    expect(clientIp(req)).toBe("127.0.0.1");
  });

  it("ignores CF-Connecting-IP from an untrusted peer even when it is a valid IPv6 literal", () => {
    const req = mockReq(
      { "cf-connecting-ip": "2001:db8::1" },
      "::ffff:127.0.0.1",
      "::ffff:127.0.0.1",
    );
    expect(clientIp(req)).toBe("::ffff:127.0.0.1");
  });

  it("honours CF-Connecting-IP when the socket peer is a trusted tunnel peer (IPv4)", () => {
    setTrustedCloudflarePeers(new Set(["127.0.0.1"]));
    const req = mockReq({ "cf-connecting-ip": "198.51.100.7" }, "127.0.0.1", "127.0.0.1");
    expect(clientIp(req)).toBe("198.51.100.7");
  });

  it("honours CF-Connecting-IP when the socket peer is a trusted tunnel peer (IPv6, mapped form)", () => {
    setTrustedCloudflarePeers(new Set(["127.0.0.1"]));
    const req = mockReq(
      { "cf-connecting-ip": "2001:db8::1" },
      "::ffff:127.0.0.1",
      "::ffff:127.0.0.1",
    );
    expect(clientIp(req)).toBe("2001:db8::1");
  });

  it("does not honour CF-Connecting-IP when the socket peer is not in the trusted set", () => {
    setTrustedCloudflarePeers(new Set(["203.0.113.10"]));
    const req = mockReq({ "cf-connecting-ip": "198.51.100.7" }, "127.0.0.1", "127.0.0.1");
    expect(clientIp(req)).toBe("127.0.0.1");
  });

  it("does not honour CF-Connecting-IP from a trusted peer when it is malformed", () => {
    setTrustedCloudflarePeers(new Set(["127.0.0.1"]));
    const req = mockReq(
      { "cf-connecting-ip": "not-an-ip" },
      "127.0.0.1",
      "127.0.0.1",
    );
    expect(clientIp(req)).toBe("127.0.0.1");
  });

  it("does not honour CF-Connecting-IP from a trusted peer when it is not a valid IP literal (out-of-range octet)", () => {
    setTrustedCloudflarePeers(new Set(["127.0.0.1"]));
    const req = mockReq(
      { "cf-connecting-ip": "198.51.100.999" },
      "127.0.0.1",
      "127.0.0.1",
    );
    expect(clientIp(req)).toBe("127.0.0.1");
  });

  it("treats an empty CF-Connecting-IP as absent", () => {
    const req = mockReq({ "cf-connecting-ip": "" }, "127.0.0.1", "127.0.0.1");
    expect(clientIp(req)).toBe("127.0.0.1");
  });

  it("falls back to req.ip when the header is absent", () => {
    const req = mockReq({}, "127.0.0.1", "127.0.0.1");
    expect(clientIp(req)).toBe("127.0.0.1");
  });

  it("falls back to the socket address when req.ip is missing", () => {
    const req = mockReq({}, undefined, "192.0.2.5");
    expect(clientIp(req)).toBe("192.0.2.5");
  });

  it("never returns the spoofed header from an untrusted peer even when req.ip is missing", () => {
    const req = mockReq({ "cf-connecting-ip": "spoofed.example" }, undefined, undefined);
    expect(clientIp(req)).toBe("unknown");
  });

  it("ignores CF-Connecting-IP when there is no socket peer to match against", () => {
    setTrustedCloudflarePeers(new Set(["127.0.0.1"]));
    const req = mockReq({ "cf-connecting-ip": "198.51.100.7" }, "127.0.0.1", undefined);
    expect(clientIp(req)).toBe("127.0.0.1");
  });
});
