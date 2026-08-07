import { config } from "../config";
import { logger } from "./logger";

// 4B.1 — transactional email via Resend's REST API (no SDK: a single POST is
// all the send path needs, and adding the package is supply-chain surface the
// logging path doesn't require). When no provider is configured the email is
// handled in-process instead of sent, and the behaviour is ENVIRONMENT-
// dependent (not just provider-dependent):
//   • non-production (dev/test): the FULL message is logged at info — the
//     reset link is the entire point of the fallback, and without it a reset
//     cannot be completed.
//   • production: recipient + subject only, plus a loud warn that reset emails
//     cannot be delivered until RESEND_API_KEY and MAIL_FROM are set. A reset
//     link in a production log file is a live credential, so the body is never
//     written there. The app still boots — a self-hosted operator without mail
//     gets a working app, minus reset.
// With a provider configured, the body is never logged either.

const RESEND_API_URL = "https://api.resend.com/emails";

export type MailMessage = {
  to: string;
  subject: string;
  html: string;
};

export type SendMailResult = { ok: true; mode: "log" | "send" };

/**
 * Sends an email, or — with RESEND_API_KEY / MAIL_FROM unset — handles it
 * in-process (dev: log the full message; production: log recipient + subject
 * and warn) and returns success. Throws only when a configured provider is
 * actually reachable-but-failing; callers treat that as best-effort (a dead
 * mail provider must never break the requesting flow).
 */
export async function sendMail(message: MailMessage): Promise<SendMailResult> {
  if (!config.RESEND_API_KEY || !config.MAIL_FROM) {
    if (config.NODE_ENV === "production") {
      // The body (which carries the reset link) stays out of production logs.
      logger.warn(
        { to: message.to, subject: message.subject },
        "email not delivered: no mail provider configured — set RESEND_API_KEY and MAIL_FROM so password-reset emails can be sent",
      );
    } else {
      // Developer path: logging the link is how the flow completes without a
      // provider. This branch never runs in production (see the guard above).
      logger.info(
        { to: message.to, subject: message.subject, html: message.html },
        "email not sent: no mail provider configured (dev) — the message body follows",
      );
    }
    return { ok: true, mode: "log" };
  }

  const apiKey: string = config.RESEND_API_KEY;
  const from: string = config.MAIL_FROM;

  const res = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: message.to,
      subject: message.subject,
      html: message.html,
    }),
  });

  if (!res.ok) {
    // Resend's error body is a diagnostic, never a secret — but only the status
    // plus that body is reported; the request (which holds the token) is not.
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      // ignore — the status alone is enough to report
    }
    throw new Error(
      `email send failed (${res.status})${detail ? `: ${detail}` : ""}`,
    );
  }

  return { ok: true, mode: "send" };
}
