import { describe, expect, it } from "vitest";
import { errorSummary, stripAnsi, truncateText } from "../../src/lib/text";

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

describe("errorSummary", () => {
  it("returns an ordinary Error's message", () => {
    expect(errorSummary(new Error("boom"))).toBe("boom");
  });

  it("returns non-Error rejection values as-is", () => {
    expect(errorSummary("string reason")).toBe("string reason");
    expect(errorSummary(42)).toBe("42");
  });

  it("unwraps an AggregateError into every cause message, joined", () => {
    const agg = new AggregateError(
      [
        new Error("OTP timeout: no OTP submitted within time limit"),
        new Error("IMAP polling aborted"),
      ],
      "All promises were rejected",
    );
    // The whole point: AggregateError.message is the useless literal
    // "All promises were rejected" — the causes carry the diagnosis.
    expect(agg.message).toBe("All promises were rejected");
    expect(errorSummary(agg)).toBe(
      "OTP timeout: no OTP submitted within time limit; IMAP polling aborted",
    );
  });

  it("falls back to AggregateError.message when it has no causes", () => {
    expect(errorSummary(new AggregateError([], "no causes"))).toBe("no causes");
  });
});
