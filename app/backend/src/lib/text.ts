// Dependency-free text helpers shared across services. Kept out of the logger
// and the transport so they stay pure and unit-testable.

// ANSI SGR escape sequences (colour, dim/bold, reset): \x1b[2m, \x1b[22m, …
// Playwright error strings carry these; they render as garbage glyphs in
// user-facing output (Telegram, the RunsPanel timeline).
const ANSI_SGR = /\x1b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_SGR, "");
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
