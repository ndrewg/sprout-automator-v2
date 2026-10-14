// Dependency-free text helpers shared across services. Kept out of the logger
// and the transport so they stay pure and unit-testable.

// ANSI SGR escape sequences (colour, dim/bold, reset): \x1b[2m, \x1b[22m, …
// Playwright error strings carry these; they render as garbage glyphs in
// user-facing output (Telegram, the RunsPanel timeline).
// oxlint-disable-next-line eslint/no-control-regex -- intentional: matching the ESC control character is the module's whole purpose.
const ANSI_SGR = /\x1b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_SGR, "");
}

/**
 * Field names that carry a secret. The logger redacts object properties with
 * these names (`lib/logger.ts`), and `redactSecrets` redacts `name=value` /
 * `name: value` pairs with these names inside free text. One list, so a new
 * secret field is added once and covered in both places.
 */
export const SECRET_FIELD_NAMES = [
  "password",
  "appPassword",
  "gmailAppPassword",
  "code",
  "otp",
  "sid",
  "telegramBotToken",
  "botToken",
  "RESEND_API_KEY",
  "APP_ENCRYPTION_KEY",
  "SESSION_SECRET",
] as const;

// "code" and "otp" are ordinary words in error text ("error code: ECONNRESET"),
// so for those two only a run of digits counts as the secret value — an OTP is
// digits. Every other name redacts whatever value follows it.
const DIGITS_ONLY = new Set(["code", "otp"]);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const FIELD_PATTERNS = SECRET_FIELD_NAMES.map((name) => {
  // A quoted value is redacted up to its closing quote (so "abcd efgh" goes
  // whole); an unquoted one up to the next separator.
  const value = DIGITS_ONLY.has(name)
    ? String.raw`["']?\d{4,10}\b["']?`
    : String.raw`(?:"[^"]*"|'[^']*'|[^\s,;&"'}]+)`;
  // name, optional closing quote (a JSON key), then = or :.
  return new RegExp(String.raw`(\b${escapeRegExp(name)}["']?\s*[=:]\s*)${value}`, "gi");
});

// A Telegram bot token is "<bot id>:<35-char secret>" and is recognisable on
// its own, e.g. inside an api.telegram.org URL. No leading \b: in
// ".../bot123456789:AAH…" the id follows "bot" with no word boundary.
const TELEGRAM_TOKEN = /\d{6,12}:[A-Za-z0-9_-]{30,}/g;
// Credentials embedded in a URL: scheme://user:secret@host
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi;

/**
 * Replace anything secret-shaped in free text with "[Redacted]". Error text
 * reaches `runs.error` and the Telegram failure message verbatim, so this runs
 * on every `errorSummary` result. Best-effort by design: it catches named
 * fields, bot tokens and URL credentials, not a bare secret with no context.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of FIELD_PATTERNS) out = out.replace(pattern, "$1[Redacted]");
  out = out.replace(TELEGRAM_TOKEN, "[Redacted]");
  out = out.replace(URL_CREDENTIALS, "$1[Redacted]@");
  return out;
}

/**
 * Reduce an unknown thrown value to a one-line message. An AggregateError
 * (what Promise.any rejects with when every candidate rejects) is unwrapped so
 * the persisted `runs.error` records every underlying cause instead of the
 * opaque literal "All promises were rejected" that its `.message` always is.
 * The result is passed through `redactSecrets` before anyone stores or sends it.
 */
export function errorSummary(err: unknown): string {
  if (err instanceof AggregateError && err.errors.length > 0) {
    return redactSecrets(
      err.errors
        .map((cause) => (cause instanceof Error ? cause.message : String(cause)))
        .join("; "),
    );
  }
  return redactSecrets(err instanceof Error ? err.message : String(err));
}

const NOTIFICATION_TEXT_LIMIT = 300;

/** Clip long run-derived text for phone-readable notifications. The full text
 *  stays in the run row for forensics — only the notification truncates. */
export function truncateText(
  text: string,
  max = NOTIFICATION_TEXT_LIMIT,
): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
