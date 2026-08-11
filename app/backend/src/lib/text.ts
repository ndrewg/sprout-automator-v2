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
 * Reduce an unknown thrown value to a one-line message. An AggregateError
 * (what Promise.any rejects with when every candidate rejects) is unwrapped so
 * the persisted `runs.error` records every underlying cause instead of the
 * opaque literal "All promises were rejected" that its `.message` always is.
 */
export function errorSummary(err: unknown): string {
  if (err instanceof AggregateError && err.errors.length > 0) {
    return err.errors
      .map((cause) => (cause instanceof Error ? cause.message : String(cause)))
      .join("; ");
  }
  return err instanceof Error ? err.message : String(err);
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
