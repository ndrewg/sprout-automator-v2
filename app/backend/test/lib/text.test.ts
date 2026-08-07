import { describe, expect, it } from "vitest";
import { stripAnsi, truncateText } from "../../src/lib/text";

describe("stripAnsi", () => {
  it("removes SGR escape sequences (colour, dim, reset)", () => {
    const input = "\x1b[2mCould not\x1b[22m reach dashboard. \x1b[31mboom\x1b[0m";
    expect(stripAnsi(input)).toBe("Could not reach dashboard. boom");
  });

  it("leaves plain text untouched", () => {
    expect(stripAnsi("Already clocked IN today — skipping.")).toBe(
      "Already clocked IN today — skipping.",
    );
  });
});

describe("truncateText", () => {
  it("keeps short text intact", () => {
    expect(truncateText("short reason", 300)).toBe("short reason");
  });

  it("clips long text to ~300 chars with an ellipsis", () => {
    const long = "x".repeat(500);
    const clipped = truncateText(long);
    expect(clipped).toHaveLength(300);
    expect(clipped.endsWith("…")).toBe(true);
    expect(clipped).not.toContain("x".repeat(500));
  });
});
