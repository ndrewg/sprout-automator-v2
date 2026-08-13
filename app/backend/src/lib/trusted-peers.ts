import { isIP } from "node:net";

// Peer parsing for the CF-Connecting-IP trust gate (§8C). The gate accepts the
// header only from peers listed in TRUSTED_CLOUDFLARE_PEERS; this module owns
// the parsing, validation and matching. It is shared by config.ts (which
// refuses to boot on a malformed entry — same stance as SIGNUP_ALLOWED) and by
// middleware/security.ts (the lookup itself), so it must import neither.

export type CidrRange = {
  family: 4 | 6;
  base: bigint;
  mask: bigint;
};

export type TrustedPeerSet = {
  literals: ReadonlySet<string>;
  cidrs: readonly CidrRange[];
};

/** The gate OFF: no literal and no range, so CF-Connecting-IP is never
 * honoured. The default and the value resetRateLimits() restores. */
export function emptyTrustedPeerSet(): TrustedPeerSet {
  return { literals: new Set(), cidrs: [] };
}

/**
 * Puts a peer address (socket side or config side) into the ONE canonical form
 * the set lookup uses: lowercased, and with the IPv4-mapped IPv6 prefix
 * collapsed — "::ffff:a.b.c.d" -> "a.b.c.d". Collapsing ONLY when the
 * remainder is genuinely IPv4 keeps a mapped-form address whose tail is not a
 * dotted quad (e.g. "::ffff:0:1") as the IPv6 address it actually is.
 */
export function normalizePeer(peer: string | undefined): string | undefined {
  if (peer === undefined) return undefined;
  const lower = peer.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    const rest = lower.slice("::ffff:".length);
    return isIP(rest) === 4 ? rest : lower;
  }
  return lower;
}

/**
 * Parses the TRUSTED_CLOUDFLARE_PEERS env list ("a, b, c") into a peer set.
 * Entries are IPv4/IPv6 literals or CIDR ranges (e.g. "172.20.0.0/16").
 * Unset or empty -> the empty set, which is the gate being OFF. A malformed
 * entry THROWS naming its 1-based position and the fix — never a set that
 * matches nothing (that would be the gate silently off). Two CIDR forms are
 * refused outright for the same reason: a /0 prefix (mask 0 matches EVERY peer
 * of the family — it would silently re-open the spoofing hole while reporting
 * as armed) and a range whose address has host bits set (a log-line copy of
 * "172.20.0.5/16" would silently widen to the whole /16 — trust more than the
 * operator intended without saying so). Exported only so the unit tests can
 * pin the parse (the empty-string Compose form must behave exactly like an
 * unset variable).
 */
export function parseTrustedCloudflarePeers(
  raw: string | undefined,
): TrustedPeerSet {
  if (raw === undefined) return emptyTrustedPeerSet();
  const literals = new Set<string>();
  const cidrs: CidrRange[] = [];
  let position = 0;
  for (const part of raw.split(",")) {
    position += 1;
    const entry = part.trim();
    if (entry === "") continue;
    // entry is a non-empty string, so normalizePeer cannot return undefined.
    const normalized = normalizePeer(entry)!;
    const slash = normalized.indexOf("/");
    if (slash !== -1) {
      cidrs.push(parseCidr(normalized, position, entry));
    } else {
      const family = isIP(normalized);
      if (family === 0) {
        throw invalidEntry(
          position,
          entry,
          `"${sanitizeEntry(normalized)}" is not a valid IPv4 or IPv6 address`,
        );
      }
      if (family === 6 && normalized.includes(".")) {
        throw invalidEntry(
          position,
          entry,
          `"${sanitizeEntry(normalized)}" embeds an IPv4 address in an IPv6 address — write it in the hex form`,
        );
      }
      literals.add(normalized);
    }
  }
  return { literals, cidrs };
}

/** True when `peer` (a socket peer address) is covered by the set: it is a
 * listed literal or it falls inside one of the listed CIDR ranges. */
export function isPeerTrusted(set: TrustedPeerSet, peer: string): boolean {
  const normalized = normalizePeer(peer);
  if (normalized === undefined) return false;
  if (set.literals.has(normalized)) return true;
  const family = isIP(normalized);
  if (family === 0) return false;
  const value =
    family === 4 ? ipv4ToBigInt(normalized) : ipv6ToBigInt(normalized);
  if (value === undefined) return false;
  for (const range of set.cidrs) {
    if (range.family === family && (value & range.mask) === range.base) {
      return true;
    }
  }
  return false;
}

const MAX_PREFIX: Record<4 | 6, number> = { 4: 32, 6: 128 };

function parseCidr(
  normalized: string,
  position: number,
  original: string,
): CidrRange {
  const slash = normalized.lastIndexOf("/");
  const addr = normalized.slice(0, slash);
  const prefixText = normalized.slice(slash + 1);
  const ipFamily = isIP(addr);
  if (ipFamily === 0) {
    throw invalidEntry(
      position,
      original,
      `"${sanitizeEntry(addr)}" is not a valid IPv4 or IPv6 address`,
    );
  }
  // isIP is typed as returning number; the === 0 guard above means it is 4 or 6.
  const family: 4 | 6 = ipFamily === 6 ? 6 : 4;
  // normalizePeer collapses the ::ffff: mapped prefix to IPv4, so any IPv6
  // that still contains a dot is an embedded-IPv4 form we do not match — refuse
  // loudly rather than accept a range that can never match a normalized peer.
  if (ipFamily === 6 && addr.includes(".")) {
    throw invalidEntry(
      position,
      original,
      `"${sanitizeEntry(addr)}" embeds an IPv4 address in an IPv6 address — use the plain IPv4 CIDR form`,
    );
  }
  if (!/^\d{1,3}$/.test(prefixText)) {
    throw invalidEntry(
      position,
      original,
      `"/${sanitizeEntry(prefixText)}" is not a numeric CIDR prefix — use a value between 0 and ${MAX_PREFIX[family]}`,
    );
  }
  const prefix = Number(prefixText);
  if (prefix > MAX_PREFIX[family]) {
    throw invalidEntry(
      position,
      original,
      `prefix /${prefix} is too large for an IPv${family} address (max /${MAX_PREFIX[family]})`,
    );
  }
  if (prefix === 0) {
    throw invalidEntry(
      position,
      original,
      `prefix /0 would trust every IPv${family} peer — the gate needs the tunnel's own address or network, e.g. "172.20.0.0/16" or "172.20.0.5/32"`,
    );
  }
  const value =
    family === 4 ? ipv4ToBigInt(addr) : ipv6ToBigInt(addr);
  if (value === undefined) {
    throw invalidEntry(
      position,
      original,
      `could not parse "${sanitizeEntry(addr)}" as an IPv${family} address`,
    );
  }
  const bits = BigInt(MAX_PREFIX[family]);
  const max = (1n << bits) - 1n;
  const mask = max ^ ((1n << (bits - BigInt(prefix))) - 1n);
  const base = value & mask;
  if (base !== value) {
    const network =
      family === 4 ? bigintToIpv4(base) : bigintToIpv6(base);
    throw invalidEntry(
      position,
      original,
      `"${sanitizeEntry(addr)}/${prefix}" has host bits set; use "${network}/${prefix}" to trust the network, or "${sanitizeEntry(addr)}/${MAX_PREFIX[family]}" to trust only that address`,
    );
  }
  return { family, base, mask };
}

/**
 * The boot error interpolates operator-supplied entries, which could contain
 * control characters (a newline would split the refusal across log lines) or
 * be arbitrarily long. Cap the length first (so no escape sequence is cut
 * in half), then escape control characters and quotes via JSON.stringify so
 * the refusal reads as ONE line naming the offending value.
 */
function sanitizeEntry(entry: string, maxLength = 60): string {
  const capped =
    entry.length > maxLength ? `${entry.slice(0, maxLength)}…` : entry;
  const escaped = JSON.stringify(capped);
  return escaped.slice(1, -1);
}

function invalidEntry(position: number, entry: string, reason: string): Error {
  return new Error(
    `entry ${position} ("${sanitizeEntry(entry)}"): ${reason}. Use a comma-separated list of ` +
      `IPv4/IPv6 literals and CIDR ranges (e.g. "172.20.0.0/16")`,
  );
}

function ipv4ToBigInt(address: string): bigint {
  let result = 0n;
  for (const octet of address.split(".")) {
    result = (result << 8n) | BigInt(octet);
  }
  return result;
}

/** Formats a 32-bit value back to a dotted-quad literal — used to name the
 * network form of a range with host bits set in the boot error. */
function bigintToIpv4(value: bigint): string {
  return [
    (value >> 24n) & 0xffn,
    (value >> 16n) & 0xffn,
    (value >> 8n) & 0xffn,
    value & 0xffn,
  ].join(".");
}

/** Formats a 128-bit value back to a compressed IPv6 literal — used to name
 * the network form of a range with host bits set in the boot error. Only
 * reached for the base of a rejected entry, so cosmetic non-compression is
 * fine; the result is a plain hex literal, never an embedded-IPv4 form. */
function bigintToIpv6(value: bigint): string {
  const groups: string[] = [];
  for (let i = 0; i < 8; i += 1) {
    groups.push(
      ((value >> (BigInt(8 - 1 - i) * 16n)) & 0xffffn).toString(16),
    );
  }
  // The longest run of zero groups (length >= 2) becomes "::".
  let bestStart = -1;
  let bestLength = 0;
  let runStart = -1;
  for (let i = 0; i <= 8; i += 1) {
    if (i < 8 && groups[i] === "0") {
      if (runStart === -1) runStart = i;
    } else if (runStart !== -1) {
      if (i - runStart > bestLength) {
        bestLength = i - runStart;
        bestStart = runStart;
      }
      runStart = -1;
    }
  }
  if (bestLength < 2) return groups.join(":");
  const left = groups.slice(0, bestStart).join(":");
  const right = groups.slice(bestStart + bestLength).join(":");
  return `${left}::${right}`;
}

/** Parses a pure-hex IPv6 literal (with "::" compression) into a 128-bit
 * value. Embedded-IPv4 forms never reach here — they are refused in
 * parseCidr/parseTrustedCloudflarePeers. */
function ipv6ToBigInt(address: string): bigint | undefined {
  if (address.includes(".")) return undefined;
  const firstColon = address.indexOf("::");
  const secondColon =
    firstColon === -1 ? -1 : address.indexOf("::", firstColon + 2);
  if (secondColon !== -1) return undefined;
  const left = firstColon === -1 ? address : address.slice(0, firstColon);
  const right = firstColon === -1 ? "" : address.slice(firstColon + 2);
  const parseGroup = (group: string): number | undefined => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined;
    return Number.parseInt(group, 16);
  };
  const leftGroups: number[] = [];
  for (const group of left === "" ? [] : left.split(":")) {
    const value = parseGroup(group);
    if (value === undefined) return undefined;
    leftGroups.push(value);
  }
  const rightGroups: number[] = [];
  for (const group of right === "" ? [] : right.split(":")) {
    const value = parseGroup(group);
    if (value === undefined) return undefined;
    rightGroups.push(value);
  }
  if (firstColon === -1 && leftGroups.length !== 8) return undefined;
  if (firstColon !== -1 && leftGroups.length + rightGroups.length >= 8) {
    return undefined;
  }
  const groups: number[] = [];
  groups.push(...leftGroups);
  if (firstColon !== -1) {
    while (groups.length < 8 - rightGroups.length) {
      groups.push(0);
    }
  }
  groups.push(...rightGroups);
  let result = 0n;
  for (const group of groups) {
    result = (result << 16n) | BigInt(group);
  }
  return result;
}
