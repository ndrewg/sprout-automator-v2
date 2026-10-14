import { describe, expect, it } from "vitest";
import { invalidListEntry, quoteEntry } from "../../src/lib/config-list-errors";

describe("quoteEntry", () => {
  it("escapes a newline so the refusal stays on one line", () => {
    expect(quoteEntry("bad\nentry")).toBe("bad\\nentry");
  });

  it("escapes embedded quotes", () => {
    expect(quoteEntry('say "hi"')).toBe('say \\"hi\\"');
  });

  it("caps a long entry before escaping, with an ellipsis", () => {
    const quoted = quoteEntry("x".repeat(100));
    expect(quoted).toBe(`${"x".repeat(60)}…`);
  });
});

describe("invalidListEntry", () => {
  it("names the 1-based position, the quoted entry, the reason and the usage", () => {
    const err = invalidListEntry(2, "2026-02-31=Nope", "is not a real calendar date", "Use X.");
    expect(err.message).toBe(
      'entry 2 ("2026-02-31=Nope"): is not a real calendar date. Use X.',
    );
  });

  it("produces a single-line message even when the entry has control characters", () => {
    const err = invalidListEntry(1, "a\r\nb", "is malformed", "Use X.");
    expect(err.message).not.toMatch(/[\r\n]/);
  });
});
