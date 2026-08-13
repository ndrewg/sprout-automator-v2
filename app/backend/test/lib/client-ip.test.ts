import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import {
  clientIp,
  emptyTrustedPeerSet,
  isPeerTrusted,
  parseTrustedCloudflarePeers,
  setTrustedCloudflarePeers,
} from "../../src/middleware/security";
import { logger } from "../../src/lib/logger";

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
  // Silence logger.warn (the F3 mismatch warn fires from several of these
  // tests by design) and restore the gate-off default between tests.
  beforeEach(() => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    setTrustedCloudflarePeers(emptyTrustedPeerSet());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setTrustedCloudflarePeers(emptyTrustedPeerSet());
  });

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
    setTrustedCloudflarePeers(parseTrustedCloudflarePeers("127.0.0.1"));
    const req = mockReq({ "cf-connecting-ip": "198.51.100.7" }, "127.0.0.1", "127.0.0.1");
    expect(clientIp(req)).toBe("198.51.100.7");
  });

  it("honours CF-Connecting-IP when the socket peer is a trusted tunnel peer (IPv6, mapped form)", () => {
    setTrustedCloudflarePeers(parseTrustedCloudflarePeers("127.0.0.1"));
    const req = mockReq(
      { "cf-connecting-ip": "2001:db8::1" },
      "::ffff:127.0.0.1",
      "::ffff:127.0.0.1",
    );
    expect(clientIp(req)).toBe("2001:db8::1");
  });

  it("does not honour CF-Connecting-IP when the socket peer is not in the trusted set", () => {
    setTrustedCloudflarePeers(parseTrustedCloudflarePeers("203.0.113.10"));
    const req = mockReq({ "cf-connecting-ip": "198.51.100.7" }, "127.0.0.1", "127.0.0.1");
    expect(clientIp(req)).toBe("127.0.0.1");
  });

  it("does not honour CF-Connecting-IP from a trusted peer when it is malformed", () => {
    setTrustedCloudflarePeers(parseTrustedCloudflarePeers("127.0.0.1"));
    const req = mockReq(
      { "cf-connecting-ip": "not-an-ip" },
      "127.0.0.1",
      "127.0.0.1",
    );
    expect(clientIp(req)).toBe("127.0.0.1");
  });

  it("does not honour CF-Connecting-IP from a trusted peer when it is not a valid IP literal (out-of-range octet)", () => {
    setTrustedCloudflarePeers(parseTrustedCloudflarePeers("127.0.0.1"));
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
    setTrustedCloudflarePeers(parseTrustedCloudflarePeers("127.0.0.1"));
    const req = mockReq({ "cf-connecting-ip": "198.51.100.7" }, "127.0.0.1", undefined);
    expect(clientIp(req)).toBe("127.0.0.1");
  });

  // F1: both sides of the set lookup must be in ONE form. An operator copies
  // the peer out of a log line, where Docker/Node reports the IPv4-mapped form
  // "::ffff:172.20.0.4" — so a config written either way must match a peer
  // arriving the other way.
  it("matches a peer configured in IPv4-mapped form against a plain socket peer", () => {
    setTrustedCloudflarePeers(parseTrustedCloudflarePeers("::ffff:172.20.0.4"));
    const req = mockReq(
      { "cf-connecting-ip": "198.51.100.7" },
      "172.20.0.4",
      "172.20.0.4",
    );
    expect(clientIp(req)).toBe("198.51.100.7");
  });

  it("matches a peer configured in plain form against an IPv4-mapped socket peer (the Docker bridge case)", () => {
    setTrustedCloudflarePeers(parseTrustedCloudflarePeers("172.20.0.4"));
    const req = mockReq(
      { "cf-connecting-ip": "198.51.100.7" },
      "::ffff:172.20.0.4",
      "::ffff:172.20.0.4",
    );
    expect(clientIp(req)).toBe("198.51.100.7");
  });

  // F4 at the clientIp level: a CIDR entry behaves exactly like a literal list.
  it("honours CF-Connecting-IP from a peer inside a trusted CIDR range", () => {
    setTrustedCloudflarePeers(parseTrustedCloudflarePeers("172.20.0.0/16"));
    const req = mockReq(
      { "cf-connecting-ip": "198.51.100.7" },
      "172.20.0.4",
      "172.20.0.4",
    );
    expect(clientIp(req)).toBe("198.51.100.7");
  });

  it("ignores CF-Connecting-IP from a peer outside a trusted CIDR range", () => {
    setTrustedCloudflarePeers(parseTrustedCloudflarePeers("172.20.0.0/16"));
    const req = mockReq(
      { "cf-connecting-ip": "198.51.100.7" },
      "192.168.1.5",
      "192.168.1.5",
    );
    expect(clientIp(req)).toBe("192.168.1.5");
  });

  it("matches an IPv4-mapped socket peer against an IPv4 CIDR range", () => {
    setTrustedCloudflarePeers(parseTrustedCloudflarePeers("172.20.0.0/16"));
    const req = mockReq(
      { "cf-connecting-ip": "198.51.100.7" },
      "::ffff:172.20.0.4",
      "::ffff:172.20.0.4",
    );
    expect(clientIp(req)).toBe("198.51.100.7");
  });

  // F3: a CF-Connecting-IP arriving from a peer outside a NON-EMPTY trusted set
  // is the signature of F1/F2/F4 — a gate silently off. Warn once with the
  // observed peer; never when the set is empty (the normal state).
  it("warns once when a CF-Connecting-IP arrives from a peer outside the non-empty trusted set", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    setTrustedCloudflarePeers(parseTrustedCloudflarePeers("203.0.113.10"));
    const req = mockReq(
      { "cf-connecting-ip": "198.51.100.7" },
      "127.0.0.1",
      "127.0.0.1",
    );
    expect(clientIp(req)).toBe("127.0.0.1");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { peer: "127.0.0.1" },
      expect.stringContaining("TRUSTED_CLOUDFLARE_PEERS"),
    );
    // Once-only: a hostile flood of mismatched headers must not spam the log.
    expect(clientIp(req)).toBe("127.0.0.1");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not warn when the trusted set is empty, even with a CF-Connecting-IP present (the normal state)", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const req = mockReq(
      { "cf-connecting-ip": "198.51.100.7" },
      "127.0.0.1",
      "127.0.0.1",
    );
    expect(clientIp(req)).toBe("127.0.0.1");
    expect(warn).not.toHaveBeenCalled();
  });
});

// The trusted-peer set is populated from the TRUSTED_CLOUDFLARE_PEERS config
// key at module load, so this parse is the operator-facing opt-in path (the
// integration suite proves the budget consequences both ways). These assertions
// pin the parse, including that the empty string Compose emits for an unset key
// behaves exactly like an unset variable — both are the gate OFF — and that a
// malformed entry refuses (F2) instead of silently never matching.
describe("parseTrustedCloudflarePeers", () => {
  it("splits a comma-separated list, trimming whitespace and dropping empty entries", () => {
    const set = parseTrustedCloudflarePeers("127.0.0.1, 10.0.0.5, ::1");
    expect([...set.literals]).toEqual(["127.0.0.1", "10.0.0.5", "::1"]);
    expect(set.cidrs).toEqual([]);
  });

  it("an unset key is the empty set — the gate is OFF", () => {
    expect(parseTrustedCloudflarePeers(undefined)).toEqual(emptyTrustedPeerSet());
  });

  it("an empty string (Compose form of an unset key) is also the empty set", () => {
    expect(parseTrustedCloudflarePeers("")).toEqual(emptyTrustedPeerSet());
  });

  it("a list of only separators is the empty set", () => {
    expect(parseTrustedCloudflarePeers(" , ")).toEqual(emptyTrustedPeerSet());
  });

  it("normalises IPv4-mapped entries to the plain form (F1)", () => {
    const set = parseTrustedCloudflarePeers("::ffff:172.20.0.4");
    expect([...set.literals]).toEqual(["172.20.0.4"]);
  });

  it("is case-insensitive for IPv6 entries (F1)", () => {
    const set = parseTrustedCloudflarePeers("::FFFF:172.20.0.4");
    expect([...set.literals]).toEqual(["172.20.0.4"]);
  });

  it("refuses a malformed entry, naming its 1-based position and the fix (F2)", () => {
    expect(() => parseTrustedCloudflarePeers("172.20.0.4, 172.20..4")).toThrow(
      /entry 2/,
    );
    expect(() => parseTrustedCloudflarePeers("cloudflared")).toThrow(
      /entry 1/,
    );
    expect(() => parseTrustedCloudflarePeers("172.20.0.4;")).toThrow(/entry 1/);
    // A trailing comma is an empty entry, not an error.
    expect(() => parseTrustedCloudflarePeers("172.20.0.4,")).not.toThrow();
  });

  it("keeps an IPv4-mapped IPv6 address whose tail is not a dotted quad as IPv6 (F1)", () => {
    // "::ffff:0:1" is a valid IPv6 (the mapped form of 0.0.0.1, which Node
    // never emits as a socket address) — it must not be mangled into a bogus
    // IPv4, and it is still accepted as the IPv6 literal it is.
    const set = parseTrustedCloudflarePeers("::ffff:0:1");
    expect([...set.literals]).toEqual(["::ffff:0:1"]);
  });

  it("refuses an IPv6-with-embedded-IPv4 form we do not match, rather than silently never matching (F4)", () => {
    expect(() => parseTrustedCloudflarePeers("2001:db8::192.0.2.1")).toThrow(
      /entry 1/,
    );
  });
});

describe("CIDR peer ranges (F4)", () => {
  it("trusts an address inside the range and not one outside it", () => {
    const set = parseTrustedCloudflarePeers("172.20.0.0/16");
    expect(isPeerTrusted(set, "172.20.0.4")).toBe(true);
    expect(isPeerTrusted(set, "192.168.1.1")).toBe(false);
    expect(isPeerTrusted(set, "10.0.0.1")).toBe(false);
    expect(isPeerTrusted(set, "172.21.0.1")).toBe(false);
  });

  it("trusts addresses at the range boundaries", () => {
    const set = parseTrustedCloudflarePeers("172.20.0.0/24");
    expect(isPeerTrusted(set, "172.20.0.0")).toBe(true);
    expect(isPeerTrusted(set, "172.20.0.255")).toBe(true);
    expect(isPeerTrusted(set, "172.20.1.0")).toBe(false);
  });

  it("supports IPv6 CIDR ranges", () => {
    const set = parseTrustedCloudflarePeers("2001:db8::/32");
    expect(isPeerTrusted(set, "2001:db8::1")).toBe(true);
    expect(isPeerTrusted(set, "2001:db8:1::2")).toBe(true);
    expect(isPeerTrusted(set, "2001:db9::1")).toBe(false);
  });

  it("refuses an out-of-range CIDR mask", () => {
    expect(() => parseTrustedCloudflarePeers("172.20.0.0/33")).toThrow(
      /entry 1/,
    );
    expect(() => parseTrustedCloudflarePeers("::1/129")).toThrow(/entry 1/);
  });

  it("refuses a non-numeric CIDR mask", () => {
    expect(() => parseTrustedCloudflarePeers("172.20.0.0/abc")).toThrow(
      /entry 1/,
    );
    expect(() => parseTrustedCloudflarePeers("172.20.0.0/16x")).toThrow(
      /entry 1/,
    );
  });

  it("accepts literals and CIDR ranges together", () => {
    const set = parseTrustedCloudflarePeers("203.0.113.10, 172.20.0.0/16");
    expect(isPeerTrusted(set, "203.0.113.10")).toBe(true);
    expect(isPeerTrusted(set, "172.20.0.9")).toBe(true);
    expect(isPeerTrusted(set, "198.51.100.1")).toBe(false);
  });

  // B8: a /0 prefix has a mask of 0, so base = 0 matches EVERY peer of that
  // family — it re-opens the spoofing hole the gate exists to close while
  // reporting as armed. There is no legitimate use for it; refuse at boot and
  // say the tunnel's own address or network must be given instead.
  it("refuses a /0 prefix in either family — it would trust every peer (B8)", () => {
    for (const bad of ["0.0.0.0/0", "::/0"]) {
      expect(() => parseTrustedCloudflarePeers(bad)).toThrow(/entry 1/);
      expect(() => parseTrustedCloudflarePeers(bad)).toThrow(/trust every/);
    }
  });

  // B10: "172.20.0.5/16" must NOT silently normalize to the whole 172.20.0.0/16
  // (an operator copying cloudflared's address out of a log and appending a
  // mask would trust 65k addresses believing they trusted one). Refuse to boot
  // and name the two corrected forms.
  it("refuses an IPv4 CIDR with host bits set, naming the corrected forms (B10)", () => {
    expect(() => parseTrustedCloudflarePeers("172.20.0.5/16")).toThrow(
      /entry 1/,
    );
    expect(() => parseTrustedCloudflarePeers("172.20.0.5/16")).toThrow(
      /172\.20\.0\.0\/16/,
    );
    expect(() => parseTrustedCloudflarePeers("172.20.0.5/16")).toThrow(
      /172\.20\.0\.5\/32/,
    );
  });

  it("refuses an IPv6 CIDR with host bits set, naming the corrected forms (B10)", () => {
    expect(() => parseTrustedCloudflarePeers("2001:db8::1/32")).toThrow(
      /entry 1/,
    );
    expect(() => parseTrustedCloudflarePeers("2001:db8::1/32")).toThrow(
      /2001:db8::\/32/,
    );
    expect(() => parseTrustedCloudflarePeers("2001:db8::1/32")).toThrow(
      /2001:db8::1\/128/,
    );
  });

  it("still accepts a CIDR entry already on its network boundary (B10)", () => {
    const set = parseTrustedCloudflarePeers("172.20.0.0/16, 2001:db8::/32");
    expect(isPeerTrusted(set, "172.20.0.4")).toBe(true);
    expect(isPeerTrusted(set, "172.20.255.255")).toBe(true);
    expect(isPeerTrusted(set, "2001:db8::1")).toBe(true);
    expect(isPeerTrusted(set, "172.21.0.1")).toBe(false);
  });
});

describe("echoed boot errors (B9)", () => {
  // The refusal interpolates the operator-supplied entry; a control character
  // must not split the boot error across log lines.
  it("escapes a newline in the entry so the error stays one line", () => {
    const entry = '172.20.0.4;\n"INJECTED"\n123';
    expect(() => parseTrustedCloudflarePeers(entry)).toThrow(/\\n/);
    let caught: unknown;
    try {
      parseTrustedCloudflarePeers(entry);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toMatch(/\n/);
  });

  it("caps an over-long entry in the echoed error", () => {
    const entry = "x".repeat(500);
    expect(() => parseTrustedCloudflarePeers(entry)).toThrow(/…/);
    let caught: unknown;
    try {
      parseTrustedCloudflarePeers(entry);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message.length).toBeLessThan(entry.length);
  });
});
