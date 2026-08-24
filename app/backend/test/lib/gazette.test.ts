import { describe, it, expect } from "vitest";
import {
  classifyScope,
  parseProclamations,
  fetchGazetteProclamations,
  GAZETTE_URL,
} from "../../src/lib/gazette";

// 13B — Gazette parsing + scope classification. The scope heuristic is the
// load-bearing part and is deliberately CONSERVATIVE: only an explicit national
// marker (or a lunar/Eid name, which the PH always proclaims nationally) yields
// `national`; anything else is `regional` or `ambiguous`. Never national from
// the absence of a qualifier.

describe("classifyScope", () => {
  it("classifies an explicit 'throughout the country' proclamation as national", () => {
    expect(
      classifyScope("DECLARING DECEMBER 30 AS A SPECIAL DAY THROUGHOUT THE COUNTRY"),
    ).toBe("national");
  });

  it("classifies a lunar/Eid proclamation as national even without a qualifier", () => {
    expect(classifyScope("DECLARING EID'L FITR AS A REGULAR HOLIDAY")).toBe(
      "national",
    );
    expect(classifyScope("DECLARING THE APPROPRIATE LEGAL HOLIDAY ON THE OCCASION OF EID AL-FITR")).toBe(
      "national",
    );
  });

  it("classifies a city-scoped proclamation as regional", () => {
    expect(
      classifyScope("DECLARING A SPECIAL DAY IN THE CITY OF MANILA"),
    ).toBe("regional");
    expect(
      classifyScope("CLASSES SUSPENDED IN THE PROVINCE OF BULACAN"),
    ).toBe("regional");
  });

  it("classifies an unqualified proclamation as ambiguous — NOT national", () => {
    expect(classifyScope("DECLARING A SPECIAL NON-WORKING DAY")).toBe(
      "ambiguous",
    );
  });

  it("never infers national scope from the absence of a qualifier", () => {
    // A bare "DECLARING ... A SPECIAL DAY" with no place qualifier and no lunar
    // name must NOT be treated as national.
    expect(classifyScope("DECLARING JANUARY 2 AS A SPECIAL DAY")).toBe(
      "ambiguous",
    );
  });
});

describe("parseProclamations", () => {
  it("extracts a dated national proclamation from a page fragment", () => {
    const html =
      `<html><body><p>Proclamation No. 1234, s. 2026</p>` +
      `<p>DECLARING EID'L FITR AS A REGULAR HOLIDAY ON 2026-03-21 THROUGHOUT THE COUNTRY</p></body></html>`;
    const entries = parseProclamations(html);
    const eid = entries.find((e) => e.name.toLowerCase().includes("eid"));
    expect(eid).toBeDefined();
    expect(eid?.date).toBe("2026-03-21");
    expect(eid?.scope).toBe("national");
    expect(eid?.proclamationNo).toContain("1234");
  });

  it("classifies a city-scoped proclamation as regional", () => {
    const html =
      `<p>DECLARING A SPECIAL DAY IN THE CITY OF MANILA ON 2026-04-02</p>`;
    const entries = parseProclamations(html);
    const entry = entries.find((e) => e.date === "2026-04-02");
    expect(entry?.scope).toBe("regional");
  });

  it("returns an empty array for HTML with no dates", () => {
    expect(parseProclamations("<p>No holidays here</p>")).toEqual([]);
  });
});

describe("fetchGazetteProclamations", () => {
  it("uses the real officialgazette.gov.ph URL by default", () => {
    expect(GAZETTE_URL).toContain("officialgazette.gov.ph");
  });

  it("parses a fixture transport's response (no network)", async () => {
    const fixtureFetch = async () =>
      new Response(
        "<p>DECLARING EID'L FITR AS A REGULAR HOLIDAY ON 2026-03-21 THROUGHOUT THE COUNTRY</p>",
        { status: 200 },
      );
    const entries = await fetchGazetteProclamations(fixtureFetch);
    expect(entries.some((e) => e.scope === "national")).toBe(true);
  });

  it("throws when the transport returns a non-OK status", async () => {
    const fixtureFetch = async () => new Response("oops", { status: 500 });
    await expect(fetchGazetteProclamations(fixtureFetch)).rejects.toThrow(
      /500/,
    );
  });
});
