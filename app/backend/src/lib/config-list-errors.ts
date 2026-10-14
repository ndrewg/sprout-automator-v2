// How a boot refusal names the bad entry in a comma-separated config list
// (EXTRA_HOLIDAYS, TRUSTED_CLOUDFLARE_PEERS). Shared so the next override list
// reuses a tested formatter instead of writing a third copy (BACKLOG § 22).
//
// Only the message is shared. Each list keeps its own parser: trusted-peers does
// CIDR bigint arithmetic and extra-holidays parses dates, and a common parser
// would make both shallower. Dependency-free, because config.ts calls both
// parsers at boot.

/**
 * Make an operator-supplied value safe to quote in a one-line error. Cap the
 * length first (so no escape sequence is cut in half), then escape control
 * characters and quotes via JSON.stringify, so a stray newline cannot split the
 * refusal into lines that look like separate log entries.
 */
export function quoteEntry(entry: string, maxLength = 60): string {
  const capped = entry.length > maxLength ? `${entry.slice(0, maxLength)}…` : entry;
  return JSON.stringify(capped).slice(1, -1);
}

/**
 * The refusal for one bad list entry: its 1-based position, the quoted entry,
 * why it was rejected, and what a valid list looks like.
 *
 *   entry 2 ("2026-02-31=Nope"): is not a real calendar date. Use a comma-separated list of …
 */
export function invalidListEntry(
  position: number,
  entry: string,
  reason: string,
  usage: string,
): Error {
  return new Error(`entry ${position} ("${quoteEntry(entry)}"): ${reason}. ${usage}`);
}
