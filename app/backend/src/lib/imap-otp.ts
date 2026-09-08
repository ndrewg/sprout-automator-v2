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

export type PollForOtpOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  lookbackSeconds?: number;
  signal?: AbortSignal;
  /** Codes already submitted during this run — skip them so a retry cannot
   *  re-acquire the same stale email. */
  excludeCodes?: ReadonlySet<string>;
};

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
 * Find the most recent Sprout OTP email and extract its code.
 * - Search messages newer than `lookbackSeconds` (epoch math).
 * - Pull at most a handful, sort by UID desc.
 * - Require an OTP marker, then take the code anchored to it (extractOtpCode).
 */
export async function fetchLatestOtp(
  creds: ImapCreds,
  lookbackSeconds = 300,
  excludeCodes?: ReadonlySet<string>,
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
        const code = extractOtpCode(haystack, excludeCodes);
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
  options: PollForOtpOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const pollIntervalMs = options.pollIntervalMs ?? 5000;
  const lookbackSeconds = options.lookbackSeconds ?? 300;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (options.signal?.aborted) {
      throw new Error("IMAP polling aborted");
    }
    const result = await fetchLatestOtp(
      creds,
      lookbackSeconds,
      options.excludeCodes,
    );
    if (result.ok) return result.code;
    await sleep(pollIntervalMs);
  }
  throw new Error("IMAP polling timed out: no OTP email arrived");
}

// Phrases that mark a message as an OTP notice. The IMAP search is bounded only
// by date, so WITHOUT this gate any mail landing in the lookback window that
// happens to carry a 4-6 digit number is read as the code — and because the
// search sorts UID-descending, a newer unrelated mail beats the real OTP. That
// is how three consecutive runs submitted a wrong code and were bounced back to
// the login page on 2026-09-07/08. A message matching none of these is skipped.
const OTP_MARKERS = [
  "one-time password",
  "one time password",
  "otp",
  "verification code",
  "verify your identity",
  "security code",
] as const;

const CODE_PATTERN = /(?<!\d)(\d{4,6})(?!\d)/g;

/** How far from a marker a digit run may sit and still be treated as the code. */
const MAX_MARKER_DISTANCE = 240;

function markerPositions(lowerText: string): number[] {
  const positions: number[] = [];
  for (const marker of OTP_MARKERS) {
    let from = 0;
    for (;;) {
      const at = lowerText.indexOf(marker, from);
      if (at === -1) break;
      positions.push(at);
      from = at + marker.length;
    }
  }
  return positions;
}

/**
 * Pull the OTP out of a message, anchored to an OTP marker.
 *
 * Returns null when the text carries no marker at all — that is the gate that
 * keeps an unrelated email from being mistaken for an OTP notice. Among the
 * digit runs close enough to a marker, a 5-digit run wins (Sprout's format),
 * and within a length class the run nearest a marker wins. Ranking rather than
 * first-match means a stray number earlier in the mail can no longer outrank
 * the real code. `excludeCodes` is applied per candidate, so a code already
 * submitted this run is skipped in favour of the next best in the SAME message.
 */
function extractOtpCode(
  text: string,
  excludeCodes?: ReadonlySet<string>,
): string | null {
  const markers = markerPositions(text.toLowerCase());
  if (markers.length === 0) return null;

  const candidates: { code: string; distance: number }[] = [];
  for (const match of text.matchAll(CODE_PATTERN)) {
    const code = match[1];
    if (code === undefined || excludeCodes?.has(code)) continue;
    const at = match.index ?? 0;
    let distance = Number.POSITIVE_INFINITY;
    for (const marker of markers) {
      distance = Math.min(distance, Math.abs(at - marker));
    }
    if (distance <= MAX_MARKER_DISTANCE) candidates.push({ code, distance });
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const aFive = a.code.length === 5 ? 0 : 1;
    const bFive = b.code.length === 5 ? 0 : 1;
    if (aFive !== bFive) return aFive - bFive;
    return a.distance - b.distance;
  });
  return candidates[0]?.code ?? null;
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
