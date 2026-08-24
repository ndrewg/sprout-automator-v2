// Read the Postgres error code out of a thrown error. drizzle-orm ≥0.44 wraps
// every database-driver error in a DrizzleQueryError whose `message` is the
// SQL text and whose original driver error (with the `.code` property, e.g.
// "23505" for a unique violation) is on `cause`. The wrap can nest, so walk
// the cause chain until a `code` is found. A cycle guard keeps a malicious or
// accidental circular `cause` from looping forever.
export function pgErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  const seen = new Set<unknown>();
  while (typeof current === "object" && current !== null) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const obj = current as { code?: unknown; cause?: unknown };
    if (typeof obj.code === "string") return obj.code;
    if (!("cause" in obj) || obj.cause === undefined) return undefined;
    current = obj.cause;
  }
  return undefined;
}

/** True when the thrown error — DrizzleQueryError-wrapped or not — is a
 *  Postgres unique-violation (23505). The race guards in startRun and signup
 *  depend on this distinction. */
export function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === "23505";
}