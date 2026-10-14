import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RevealInput } from "./RevealInput";

// No DOM in this suite (vitest.config.ts), so this pins the initial render:
// hidden by default, the bare "Show" label (which must not contain the field's
// own label text — the e2e specs locate fields by label), and pass-through of
// the attributes the auth pages depend on.

const noop = () => {};

describe("RevealInput", () => {
  it("starts hidden with a Show toggle that is not a submit button", () => {
    const html = renderToStaticMarkup(
      <RevealInput id="sproutPassword" value="" onChange={noop} />,
    );
    expect(html).toContain('id="sproutPassword"');
    expect(html).toContain('type="password"');
    expect(html).toContain('aria-label="Show"');
    expect(html).toContain('type="button"');
    expect(html).not.toContain('type="text"');
  });

  it("defaults autocomplete to off (stored third-party secrets)", () => {
    const html = renderToStaticMarkup(
      <RevealInput id="botToken" value="" onChange={noop} />,
    );
    expect(html).toContain('autoComplete="off"');
  });

  it("passes auth-form attributes through to the input", () => {
    const html = renderToStaticMarkup(
      <RevealInput
        id="password"
        value=""
        onChange={noop}
        autoComplete="current-password"
        minLength={12}
        required
        placeholder="Enter password"
      />,
    );
    expect(html).toContain('autoComplete="current-password"');
    expect(html).toContain('minLength="12"');
    expect(html).toContain('required=""');
    expect(html).toContain('placeholder="Enter password"');
    expect(html).not.toContain('autoComplete="off"');
  });

  it("the toggle's accessible name never contains the word password", () => {
    const html = renderToStaticMarkup(
      <RevealInput id="password" value="" onChange={noop} />,
    );
    const labels = [...html.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]);
    expect(labels).toEqual(["Show"]);
    for (const label of labels) expect(label?.toLowerCase()).not.toContain("password");
  });
});
