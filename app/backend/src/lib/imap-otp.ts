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
