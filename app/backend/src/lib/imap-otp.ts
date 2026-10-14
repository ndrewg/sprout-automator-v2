import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { logger } from "./logger";

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
  /**
   * The instant this run asked HRHub for an OTP — when the login reached the
   * OTP page (phase 17 § 17C). Every message received before this, minus a 60 s
   * skew allowance, is discarded however tempting its code looks: a 16:15 run
   * must never submit the code from the 05:30 mail.
   */
  requestedAfter?: Date | null;
};

/** The subset of the poll options that apply to a single fetch. */
export type FetchOtpOptions = {
  lookbackSeconds?: number;
  excludeCodes?: ReadonlySet<string>;
  requestedAfter?: Date | null;
};

const IMAP_HOST = "imap.gmail.com";
const IMAP_PORT = 993;
// Sprout HR's OTP sender, confirmed from a real OTP mail on 2026-09-10.
const OTP_SENDER = "no-reply@sprout.ph";
// Clock skew between Gmail's INTERNALDATE and this host. Gmail timestamps the
// message when it ingests it, which can be slightly before our request instant
// for a mail the request caused; 60 s is the allowance for that, not for
// accepting genuinely older mail.
const OTP_CLOCK_SKEW_MS = 60_000;

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
 *
 * Two rules, both learned the hard way (phase 17 § 17C):
 *
 *  1. **Sprout's sender only.** There is no any-sender fallback any more. It
 *     existed to survive an address change, but it silently widened the search
 *     to anything in the window — and the marker gate cannot separate two
 *     messages that both look like OTP notices. If Sprout changes address the
 *     run fails with a message that NAMES that cause, which is a better failure
 *     than a wrong code.
 *  2. **Anchored to the request.** IMAP `SINCE` has DAY precision (RFC 3501), so
 *     it can only bound the search. A message whose `internalDate` is earlier
 *     than the OTP request instant (minus `OTP_CLOCK_SKEW_MS`) is discarded,
 *     whatever its code. Without this, a slow mail let a 16:15 clock-out submit
 *     the 05:30 code.
 *
 * Pull at most a handful, sort by UID desc, require an OTP marker, then take the
 * code anchored to it (extractOtpCode).
 */
export async function fetchLatestOtp(
  creds: ImapCreds,
  options: FetchOtpOptions = {},
): Promise<ImapFetchResult> {
  const lookbackSeconds = options.lookbackSeconds ?? 300;
  const client = makeClient(creds);
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const requestedAfter = options.requestedAfter ?? null;
      const notBefore =
        requestedAfter === null
          ? null
          : new Date(requestedAfter.getTime() - OTP_CLOCK_SKEW_MS);
      // Bounded by the request instant when we have one: IMAP SINCE is
      // day-precision, so this narrows the search to the right day and the
      // internalDate check below does the precise work.
      const since = notBefore ?? new Date(Date.now() - lookbackSeconds * 1000);

      // Scope the search to Sprout's OTP sender. Bounded by date alone, ANY
      // mail arriving inside the lookback window competes on UID order, and a
      // newer unrelated message wins — that is what submitted a wrong code on
      // 2026-09-07..10. Sender confirmed from a real OTP mail on 2026-09-10.
      const uids = await client.search({ since, from: OTP_SENDER }, { uid: true });
      if (!uids || uids.length === 0) {
        logger.info(
          { since, sender: OTP_SENDER },
          "no message from Sprout's OTP sender in the window",
        );
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
        const internalDate =
          msg.internalDate instanceof Date
            ? msg.internalDate
            : msg.internalDate
              ? new Date(msg.internalDate)
              : null;
        if (
          notBefore !== null &&
          internalDate !== null &&
          internalDate.getTime() < notBefore.getTime()
        ) {
          // Earlier than this run's request: it cannot be the code we asked for.
          logger.info(
            { uid, internalDate, notBefore },
            "OTP message predates this run's request — discarded",
          );
          continue;
        }
        // Decode MIME so base64/quoted-printable bodies become readable text.
        const parsed = await simpleParser(msg.source);
        const subject = parsed.subject ?? msg.envelope?.subject ?? "";
        const from = parsed.from?.text ?? "";
        const haystack = [
          subject,
          parsed.text ?? "",
          // HTML alt: strip tags so digits split across <span>s still match.
          (parsed.html || "").replace(/<[^>]+>/g, " "),
        ].join("\n");
        const code = extractOtpCode(haystack, options.excludeCodes);
        if (code) {
          // Sender and subject ONLY — never the code itself (hard rule 4).
          // This is what makes the next wrong-code incident self-diagnosing:
          // it names the message the code was taken from, which is precisely
          // the evidence the 2026-09 investigation did not have.
          logger.info({ from, subject }, "OTP code taken from message");
          return {
            ok: true,
            code,
            subject,
            date: internalDate ?? new Date(),
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
    const result = await fetchLatestOtp(creds, {
      lookbackSeconds,
      ...(options.excludeCodes !== undefined
        ? { excludeCodes: options.excludeCodes }
        : {}),
      ...(options.requestedAfter !== undefined
        ? { requestedAfter: options.requestedAfter }
        : {}),
    });
    if (result.ok) return result.code;
    await sleep(pollIntervalMs);
  }
  // No fallback any more (17C): the sender is part of the contract, so a change
  // in it is named here rather than papered over by scanning every sender.
  throw new Error(
    `No OTP mail from Sprout's sender within ${Math.round(timeoutMs / 60_000)} min ` +
      `(expected ${OTP_SENDER}). If Sprout changed its sender address, that is why.`,
  );
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
