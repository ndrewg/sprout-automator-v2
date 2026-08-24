// Official Gazette proclamation source (phase 13B). This module owns fetching
// and PARSING proclamation holidays from officialgazette.gov.ph — and nothing
// else: it has no database access (services/gazette.ts caches the result) and
// no policy about whether to skip (services/holidays.ts decides). Keeping the
// network + parsing here makes both halves testable without each other, and
// lets tests inject a fixture transport instead of hitting the real site.
//
// Parsing is a deliberately dependency-free best-effort regex over the Gazette's
// proclamation pages (the spec forbids a new HTML-parsing dependency unless
// unavoidable; phase 10 exists because deps drift). The SCOPE heuristic is the
// load-bearing part and is conservative: it never infers national scope from the
// ABSENCE of a qualifier — only an explicit national marker (or a lunar/Eid
// holiday, which the Philippines always proclaims as a national legal holiday)
// yields `national`. Anything else is `regional` or `ambiguous`, which the
// orchestrator treats as "notify, do not skip".

export type GazetteScope = "national" | "regional" | "ambiguous";

export type GazetteEntry = {
  /** YYYY-MM-DD Manila calendar day the holiday is observed on. */
  date: string;
  /** Human-readable holiday name. */
  name: string;
  /** Detected locality — only `national` may produce a skip. */
  scope: GazetteScope;
  /** The proclamation number, when it could be extracted (for notifications). */
  proclamationNo: string | null;
};

// The Gazette's public base. Not configurable: it is the single authoritative
// source for this feature, and making it a config key would just add another
// surface to keep consistent (the spec allows hardcoding it and saying so).
export const GAZETTE_URL = "https://www.officialgazette.gov.ph/";

const FETCH_TIMEOUT_MS = 15_000;

// Names that mark a proclamation NATIONAL even without an explicit "throughout
// the country" qualifier. Lunar/religious holidays (Eid) are the payoff of this
// feature (the library computes a date; the Gazette proclaims the observed one),
// and the Philippines always proclaims Eid'l Fitr / Eid'l Adha as a NATIONAL
// legal holiday, so a proclamation naming one is treated as national.
const LUNAR_NAME_MARKS = ["eid", "eidul", "eid'l", "fitr", "adha", "hajj"];

// Explicit qualifiers. Only these establish NATIONAL scope — absence of a
// qualifier is never treated as national.
const NATIONAL_MARKS = [
  "throughout the country",
  "throughout the philippines",
  "nationwide",
  "in the entire country",
  "in the whole country",
  "throughout the archipelago",
];

const REGIONAL_MARKS = [
  "in the city of",
  "in the province of",
  "in the municipality of",
  "in the region of",
  "in the ncr",
  "in the national capital region",
  "in the city",
  "in the province",
  "in the municipality",
  "in the barangay",
  "in the district",
  "only in",
];

/**
 * Fetch the proclamation holidays from the Gazette. The transport is
 * INJECTABLE (tests pass a fixture `fetchFn`), so the fetch can be tested
 * without network. Throws on a transport failure or a non-OK response — the
 * CALLER (services/gazette.ts refresh) decides that a failure is non-fatal and
 * keeps the previous cache.
 */
export async function fetchGazetteProclamations(
  fetchFn: typeof fetch = fetch,
): Promise<GazetteEntry[]> {
  const res = await fetchFn(GAZETTE_URL, {
    method: "GET",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`officialgazette.gov.ph responded ${res.status}`);
  }
  const html = await res.text();
  return parseProclamations(html);
}

/**
 * Parse proclamation holidays out of a Gazette HTML page into structured
 * entries. Best-effort regex over the page's text: it looks for date + title
 * pairs and classifies each title's scope. Purely functional so it can be
 * unit-tested with a fixture string; correctness against LIVE Gazette markup is
 * a [manual] check (a real proclamation day).
 */
export function parseProclamations(html: string): GazetteEntry[] {
  const text = htmlToText(html);
  const entries: GazetteEntry[] = [];
  const seen = new Set<string>();

  // A loose pass: find DATE + title fragments. Real Gazette proclamation pages
  // carry "Proclamation No. 1234, s. 2026" plus a DATE and a title ending in a
  // declared holiday. We match the most common shape: a title line containing a
  // date and a holiday-ish phrase.
  const dateRe = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g;
  let m: RegExpExecArray | null;
  while ((m = dateRe.exec(text)) !== null) {
    // The regex guarantees 4 capture groups, so m[1..3] are present.
    const date = `${m[1]}-${pad2(m[2]!)}-${pad2(m[3]!)}`;
    if (!seen.has(date)) {
      seen.add(date);
      const context = text.slice(Math.max(0, m.index - 80), m.index + 160);
      const name = extractHolidayName(context) ?? "Proclamation holiday";
      const scope = classifyScope(name + " " + context);
      const proclamationNo = extractProclamationNo(context);
      entries.push({ date, name, scope, proclamationNo });
    }
  }
  return entries;
}

// --- Scope classification ----------------------------------------------------

/**
 * Classify a proclamation title's scope. NATIONAL only on an explicit national
 * marker or a lunar/Eid name; REGIONAL on a place qualifier; otherwise
 * AMBIGUOUS. The fallback is deliberately ambiguous — never infer national from
 * the absence of a qualifier.
 */
export function classifyScope(title: string): GazetteScope {
  const lower = title.toLowerCase();
  if (NATIONAL_MARKS.some((m) => lower.includes(m))) return "national";
  if (LUNAR_NAME_MARKS.some((m) => lower.includes(m))) return "national";
  if (REGIONAL_MARKS.some((m) => lower.includes(m))) return "regional";
  return "ambiguous";
}

// --- Tiny HTML -> text -------------------------------------------------------

function htmlToText(html: string): string {
  // Strip tags and decode the common entities. Good enough to find dates and
  // titles in a proclamation page; not a full parser (by design — no dep).
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Best-effort: pull a holiday-ish name from the context around a date. */
function extractHolidayName(context: string): string | null {
  const marks = ["eid", "christmas", "new year", "national heroes", "independence", "ninoy", "all saints", "all souls", "immaculate", "rizal", "bonifacio", "labor day", "valentine", "holy week", "maundy", "good friday"];
  const lower = context.toLowerCase();
  for (const mark of marks) {
    const at = lower.indexOf(mark);
    if (at !== -1) {
      const start = Math.max(0, at - 3);
      const end = Math.min(context.length, at + 40);
      return context.slice(start, end).replace(/^[^A-Za-z]+/, "").trim().replace(/\s{2,}/g, " ") || null;
    }
  }
  return null;
}

/** Best-effort: extract "Proclamation No. 1234, s. 2026" -> "No. 1234, s. 2026". */
function extractProclamationNo(context: string): string | null {
  const m = /proclamation\s+no\.?\s*([0-9]+)(?:[,\s]+s\.\s*(\d{4}))?/i.exec(context);
  if (!m) return null;
  return m[2] ? `No. ${m[1]}, s. ${m[2]}` : `No. ${m[1]}`;
}

function pad2(n: string): string {
  return n.length === 1 ? `0${n}` : n;
}
