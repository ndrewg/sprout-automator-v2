import { describe, expect, it } from "vitest";
import {
  errorSummary,
  redactSecrets,
  stripAnsi,
  truncateText,
} from "../../src/lib/text";

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

  // BACKLOG § 11.2: errorSummary feeds runs.error and the Telegram failure
  // message verbatim, so a secret-bearing cause must never pass through it.
  it("redacts a secret carried by a cause before it is stored or sent", () => {
    const agg = new AggregateError(
      [
        new Error("login failed: password=hunter2-correct-horse"),
        new Error('IMAP said {"appPassword":"abcd efgh"}'),
      ],
      "All promises were rejected",
    );
    const summary = errorSummary(agg);
    expect(summary).not.toContain("hunter2-correct-horse");
    expect(summary).not.toContain("abcd");
    expect(summary).not.toContain("efgh");
    expect(summary).toContain("password=[Redacted]");
  });

  it("redacts a single Error's message too", () => {
    expect(errorSummary(new Error("submitted otp: 123456 and it was rejected"))).toBe(
      "submitted otp: [Redacted] and it was rejected",
    );
  });
});

describe("redactSecrets", () => {
  it("keeps ordinary diagnostic text that merely uses the word 'code'", () => {
    const text = "connect ECONNREFUSED 127.0.0.1:993 (error code: ECONNREFUSED)";
    expect(redactSecrets(text)).toBe(text);
  });

  it("redacts a numeric OTP following 'code'", () => {
    expect(redactSecrets("Entered code=482913 on the OTP page")).toBe(
      "Entered code=[Redacted] on the OTP page",
    );
  });

  it("redacts a Telegram bot token wherever it appears", () => {
    // Built at runtime so no token-shaped literal sits in the repo for secret
    // scanners to flag. It is obviously fake: "x" repeated.
    const secret = "x".repeat(35);
    const url = `https://api.telegram.org/bot123456789:${secret}/sendMessage`;
    const out = redactSecrets(`request to ${url} failed`);
    expect(out).not.toContain(secret);
    expect(out).toContain("[Redacted]");
  });

  it("redacts credentials embedded in a URL", () => {
    expect(redactSecrets("could not reach postgres://sprout:s3cret@db:5432/sprout")).toBe(
      "could not reach postgres://sprout:[Redacted]@db:5432/sprout",
    );
  });

  it("matches field names case-insensitively", () => {
    expect(redactSecrets("Password: topsecret!")).toBe("Password: [Redacted]");
  });
});
