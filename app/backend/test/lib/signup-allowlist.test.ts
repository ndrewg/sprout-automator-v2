import { describe, expect, it } from "vitest";
import {
  isEmailAllowed,
  parseSignupAllowlist,
} from "../../src/lib/signup-allowlist";

describe("parseSignupAllowlist", () => {
  it("undefined becomes an empty list (signup open)", () => {
    expect(parseSignupAllowlist(undefined)).toEqual([]);
  });

  it("splits on commas, trims, and drops empties", () => {
    expect(
      parseSignupAllowlist(" orchard.com.au , maz.getutua@gmail.com , ,"),
    ).toEqual(["orchard.com.au", "maz.getutua@gmail.com"]);
  });

  it("lowercases entries so matching is case-insensitive", () => {
    expect(parseSignupAllowlist("Example.com, Maz.Getutua@Gmail.com")).toEqual([
      "example.com",
      "maz.getutua@gmail.com",
    ]);
  });
});

describe("isEmailAllowed", () => {
  it("a domain entry admits any address at that exact domain", () => {
    const list = ["orchard.com.au", "example.com"];
    expect(isEmailAllowed("maz@orchard.com.au", list)).toBe(true);
    expect(isEmailAllowed("someone@example.com", list)).toBe(true);
  });

  it("a domain entry does not admit subdomains or look-alike domains", () => {
    const list = ["example.com"];
    expect(isEmailAllowed("user@sub.example.com", list)).toBe(false);
    expect(isEmailAllowed("user@notexample.com", list)).toBe(false);
  });

  it("an exact-address entry admits only that address", () => {
    const list = ["maz.getutua@gmail.com"];
    expect(isEmailAllowed("maz.getutua@gmail.com", list)).toBe(true);
    expect(isEmailAllowed("other@gmail.com", list)).toBe(false);
  });

  it("an exact address does not match via a coincidental domain entry", () => {
    const list = ["maz.getutua@gmail.com"];
    // gmail.com alone would be a different (wider) allowlist.
    expect(isEmailAllowed("maz@example.com", list)).toBe(false);
  });

  it("matching ignores case on the email side too", () => {
    const list = ["example.com", "maz.getutua@gmail.com"];
    expect(isEmailAllowed("MAZ.GETUTUA@GMAIL.COM", list)).toBe(true);
    expect(isEmailAllowed("Someone@Example.COM", list)).toBe(true);
  });

  it("an empty allowlist admits nobody (the route treats it as open)", () => {
    expect(isEmailAllowed("anyone@example.com", [])).toBe(false);
  });

  // A malformed entry must fail closed. A bare "@" is read as an exact-address
  // entry (it contains "@"), so it can only ever match the literal address "@",
  // which no real email is. The risk this guards against is a future refactor
  // treating "@" as a domain suffix and admitting everyone.
  it("a bare @ entry admits nobody", () => {
    expect(isEmailAllowed("user@example.com", ["@"])).toBe(false);
    expect(isEmailAllowed("anyone@orchard.com.au", ["@"])).toBe(false);
  });

  it("a bare @ alongside a real entry does not widen it", () => {
    const list = ["@", "orchard.com.au"];
    expect(isEmailAllowed("maz@orchard.com.au", list)).toBe(true);
    expect(isEmailAllowed("stranger@example.com", list)).toBe(false);
  });
});
