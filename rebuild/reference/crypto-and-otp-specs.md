# Reference — Crypto & OTP Specs

Copy-paste-ready, debugging-paid-for code for the two most security- and correctness-sensitive helpers. **Reproduce verbatim.** Attach to **Phase 1** (encryption) and **Phase 2** (IMAP/OTP).

---

## AES-256-GCM credential encryption — `src/lib/encryption.ts` (copy verbatim)

**Byte layout:** `base64url( version(1, 0x01) || iv(12, random) || tag(16) || ciphertext )`.

Why each part: authenticated encryption (GCM) means a corrupted DB byte throws instead of returning garbage; random per-value IV means encrypting the same plaintext twice doesn't reveal equality; the version byte makes future key/algorithm rotation dispatchable without breaking historical rows.

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../config";

// AES-256-GCM. Payload format: base64url( v1 || iv(12) || tag(16) || ciphertext )
// "v1" prefix byte (0x01) makes future key/algorithm rotation explicit.

const VERSION = 0x01;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY = Buffer.from(config.APP_ENCRYPTION_KEY, "hex");
if (KEY.length !== 32) {
  throw new Error(
    "APP_ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex chars)",
  );
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([Buffer.from([VERSION]), iv, tag, ct]);
  return payload.toString("base64url");
}

export function decrypt(token: string): string {
  const buf = Buffer.from(token, "base64url");
  if (buf.length < 1 + IV_LEN + TAG_LEN) {
    throw new Error("ciphertext too short");
  }
  const version = buf[0];
  if (version !== VERSION) {
    throw new Error(`unsupported ciphertext version: ${version}`);
  }
  const iv = buf.subarray(1, 1 + IV_LEN);
  const tag = buf.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const ct = buf.subarray(1 + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plaintext.toString("utf8");
}

export function encryptOptional(value: string | null | undefined): string | null {
  if (value == null || value === "") return null;
  return encrypt(value);
}

export function decryptOptional(token: string | null | undefined): string | null {
  if (token == null || token === "") return null;
  return decrypt(token);
}
```

**Rules:** this is the only module that touches `*_enc` columns. Never reuse an IV (generate fresh per `encrypt()`). `encryptOptional("")` returns `null` (empty = "clear").

⚑ RECOMMENDED test (`vitest`): round-trip (`decrypt(encrypt(x)) === x`); two encryptions of the same input produce different ciphertext; flipping any byte makes `decrypt` throw; a `0x02` version byte throws "unsupported".

---

## Argon2id password hashing — `src/lib/passwords.ts` (copy verbatim)

```ts
import { hash, verify, Algorithm } from "@node-rs/argon2";

const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  // OWASP 2024 minimums for interactive logins.
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTIONS);
}

export async function verifyPassword(
  storedHash: string,
  plain: string,
): Promise<boolean> {
  try {
    return await verify(storedHash, plain);
  } catch {
    return false;
  }
}
```

The dummy hash used for timing-equalization on nonexistent users (in the login route)
**must be a REAL Argon2id hash computed with the same options** — compute it once at
module load from a throwaway random secret:
```ts
import { randomBytes } from "node:crypto";
// In routes/auth.ts:
const dummyHashPromise: Promise<string> = hashPassword(
  randomBytes(32).toString("hex"),
);
// no-such-user branch: await verifyPassword(await dummyHashPromise, password);
```
> ⚠️ Do **NOT** hand-write a fake encoded hash (e.g. `$argon2id$v=19$m=19456,t=2,p=1$` +
> `"a".repeat(22)` + `$` + `"b".repeat(43)`). `@node-rs/argon2` v2 rejects a structurally
> invalid hash and `verify()` returns in ~3.5 ms instead of doing the ~14 ms memory-hard
> work — which **reintroduces the timing side-channel** the dummy verify exists to remove.
> A real hash makes `verify()` do full work, so login timing no longer reveals whether the
> email exists. (Found & fixed during the Phase 1 build.)

---

## IMAP OTP retrieval — `src/lib/imap-otp.ts` (copy verbatim)

The only module that imports `imapflow`/`mailparser`. Host/port are Gmail-specific constants.

```ts
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

export type ImapCreds = {
  email: string;
  appPassword: string;
};

export type ImapFetchResult =
  | { ok: true; code: string; subject: string; date: Date }
  | { ok: false; reason: "no_message" | "no_code" };

export type ImapTestResult =
  | { ok: true; messageCount: number }
  | { ok: false; error: string };

const IMAP_HOST = "imap.gmail.com";
const IMAP_PORT = 993;

function makeClient(creds: ImapCreds): ImapFlow {
  return new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: creds.email, pass: creds.appPassword },
    logger: false,
  });
}

/**
 * Test that IMAP credentials are valid. Returns either a success with the
 * inbox message count, or a clear error message safe to show the user.
 */
export async function testImapConnection(
  creds: ImapCreds,
): Promise<ImapTestResult> {
  const client = makeClient(creds);
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const mailbox = client.mailbox;
      const messageCount =
        typeof mailbox === "object" && mailbox && "exists" in mailbox
          ? (mailbox.exists as number)
          : 0;
      return { ok: true, messageCount };
    } finally {
      lock.release();
    }
  } catch (err: unknown) {
    return { ok: false, error: humanizeImapError(err) };
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * Find the most recent Sprout OTP email and extract the 5-digit code.
 * - Search messages newer than `lookbackSeconds` (epoch math).
 * - Pull at most a handful, sort by UID desc.
 * - Look for a 5-digit run inside subject + body text.
 */
export async function fetchLatestOtp(
  creds: ImapCreds,
  lookbackSeconds = 300,
): Promise<ImapFetchResult> {
  const client = makeClient(creds);
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const since = new Date(Date.now() - lookbackSeconds * 1000);
      const uids = await client.search({ since }, { uid: true });
      if (!uids || uids.length === 0) {
        return { ok: false, reason: "no_message" };
      }
      // Sort UIDs descending — newer UIDs are larger numbers on Gmail.
      const sorted = [...uids].sort((a, b) => b - a).slice(0, 5);

      for (const uid of sorted) {
        const msg = await client.fetchOne(
          String(uid),
          { source: true, envelope: true, internalDate: true },
          { uid: true },
        );
        if (!msg || !msg.source) continue;
        // Decode MIME so base64/quoted-printable bodies become readable text.
        const parsed = await simpleParser(msg.source);
        const subject = parsed.subject ?? msg.envelope?.subject ?? "";
        const haystack = [
          subject,
          parsed.text ?? "",
          // HTML alt: strip tags so digits split across <span>s still match.
          (parsed.html || "").replace(/<[^>]+>/g, " "),
        ].join("\n");
        const code = extractOtpCode(haystack);
        if (code) {
          return {
            ok: true,
            code,
            subject,
            date:
              msg.internalDate instanceof Date
                ? msg.internalDate
                : msg.internalDate
                  ? new Date(msg.internalDate)
                  : new Date(),
          };
        }
      }
      return { ok: false, reason: "no_code" };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * Poll IMAP until an OTP is found or timeout elapses.
 */
export async function pollForOtp(
  creds: ImapCreds,
  options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    lookbackSeconds?: number;
    signal?: AbortSignal;
  } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const pollIntervalMs = options.pollIntervalMs ?? 5000;
  const lookbackSeconds = options.lookbackSeconds ?? 300;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (options.signal?.aborted) {
      throw new Error("IMAP polling aborted");
    }
    const result = await fetchLatestOtp(creds, lookbackSeconds);
    if (result.ok) return result.code;
    await sleep(pollIntervalMs);
  }
  throw new Error("IMAP polling timed out: no OTP email arrived");
}

function extractOtpCode(text: string): string | null {
  // Sprout OTPs are 5 digits. Accept 4–6 defensively, but prefer 5.
  // Prefer a digit run surrounded by non-digits (an isolated code, not part
  // of a longer number).
  const matches = text.match(/(?<!\d)(\d{4,6})(?!\d)/g);
  if (!matches || matches.length === 0) return null;
  const fiveDigit = matches.find((m) => m.length === 5);
  return fiveDigit ?? matches[0] ?? null;
}

function humanizeImapError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  const responseStatus =
    err && typeof err === "object" && "responseStatus" in err
      ? String((err as { responseStatus: unknown }).responseStatus)
      : "";
  const authMarkers = [
    "invalid credentials",
    "authentication failed",
    "authenticationfailed",
    "command failed",
    "auth",
    "no [authenticationfailed]",
  ];
  if (
    authMarkers.some((m) => lower.includes(m)) ||
    responseStatus.toUpperCase() === "NO"
  ) {
    return "Gmail rejected the credentials. Double-check the address, and make sure you used an App Password (not your normal Google password) generated with 2-Step Verification enabled.";
  }
  if (lower.includes("enotfound") || lower.includes("network")) {
    return "Couldn't reach imap.gmail.com. Check the server's network connectivity.";
  }
  if (lower.includes("certificate") || lower.includes("tls")) {
    return "TLS connection to Gmail failed.";
  }
  return `IMAP error: ${message}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

**Rules:** don't widen the regex (`\d{4,6}`, prefer 5 — wider matches timestamps/totals). MIME parsing via `mailparser` is mandatory (raw `msg.source` hides the digits in base64/HTML). All user-facing IMAP errors go through `humanizeImapError`.

⚑ RECOMMENDED test (`vitest`) for `extractOtpCode`: `"Your code is 48213"` → `"48213"`; prefers the 5-digit over a 4-digit elsewhere in the text; `"Order #1234567 total 9999"` (no isolated 4–6 run that's the code) behaves as specified; HTML with digits split across spans matches after tag-stripping.

---

## Manual-OTP bridge — `src/automation/otp-bridge.ts` (copy verbatim)

Per-`runId` (not module-global) so concurrent users are isolated.

```ts
// Per-run OTP bridge: multiple users can clock in concurrently, so the
// "I am waiting for an OTP" state must be keyed by runId, not module-global.

type Resolver = (code: string) => void;
type Rejecter = (err: Error) => void;

type PendingOtp = {
  resolve: Resolver;
  reject: Rejecter;
  timeout: NodeJS.Timeout;
};

const pending = new Map<string, PendingOtp>();

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export function isWaitingForOtp(runId: string): boolean {
  return pending.has(runId);
}

export function submitOtp(runId: string, code: string): boolean {
  const entry = pending.get(runId);
  if (!entry) return false;
  clearTimeout(entry.timeout);
  pending.delete(runId);
  entry.resolve(code);
  return true;
}

export function waitForOtp(
  runId: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  if (pending.has(runId)) {
    throw new Error(`Already waiting for OTP on run ${runId}`);
  }
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(runId);
      reject(new Error("OTP timeout: no OTP submitted within time limit"));
    }, timeoutMs);
    pending.set(runId, { resolve, reject, timeout });
  });
}

export function cancelWait(runId: string): void {
  const entry = pending.get(runId);
  if (!entry) return;
  clearTimeout(entry.timeout);
  pending.delete(runId);
  entry.reject(new Error("OTP wait cancelled"));
}
```

## PH holidays — `src/lib/ph-holidays.ts` (copy verbatim)

```ts
import Holidays from "date-holidays";

const hd = new Holidays("PH");

/** Manual overrides for proclamation-only days the library hasn't picked up. */
const EXTRAS: Record<string, string> = {
  // "2026-02-17": "Chinese New Year",
};

/** Holiday types we treat as "skip the auto clock action". */
const SKIP_TYPES = new Set(["public", "bank"]);

/**
 * Returns the holiday name if the given date (interpreted in Asia/Manila) is
 * a Philippine public holiday, or null otherwise.
 */
export function isPhilippineHoliday(date: Date = new Date()): string | null {
  const iso = manilaDateString(date);
  if (EXTRAS[iso]) return EXTRAS[iso];

  const hits = hd.isHoliday(date);
  if (Array.isArray(hits)) {
    const match = hits.find((h) => SKIP_TYPES.has(h.type));
    if (match) return match.name;
  }
  return null;
}

/** Format `date` as `YYYY-MM-DD` in Asia/Manila. */
export function manilaDateString(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function isYearCovered(_date: Date = new Date()): boolean {
  return true;
}
```
