// Email allowlist for signup gating (§4A.2). SIGNUP_ALLOWED is a
// comma-separated list where an entry containing '@' is an exact address and
// an entry without one is a whole domain. An empty list means "signup is open
// to all" — valid outside production (config.ts enforces the production rule).

export function parseSignupAllowlist(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const entries: string[] = [];
  for (const part of raw.split(",")) {
    const entry = part.trim().toLowerCase();
    if (entry.length > 0) entries.push(entry);
  }
  return entries;
}

export function isEmailAllowed(email: string, allowlist: string[]): boolean {
  const emailLower = email.toLowerCase();
  for (const entry of allowlist) {
    if (entry.includes("@")) {
      if (emailLower === entry) return true;
    } else if (emailLower.endsWith(`@${entry}`)) {
      return true;
    }
  }
  return false;
}
