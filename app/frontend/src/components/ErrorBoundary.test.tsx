import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ErrorInfo, ReactNode } from "react";
import {
  AppErrorFallback,
  ErrorBoundary,
  PanelErrorFallback,
} from "./ErrorBoundary";

// This suite runs without a DOM (see vitest.config.ts), and React does not run
// error boundaries during server rendering, so the boundary is driven through
// the same lifecycle React uses on the client: getDerivedStateFromError on a
// throw, componentDidCatch for the log, then render(). setState is applied
// synchronously, the way React would commit it.

function Boom(): ReactNode {
  throw new Error("secret internal detail at /srv/app/stack.ts:42");
}

function mount(props: ConstructorParameters<typeof ErrorBoundary>[0]) {
  const boundary = new ErrorBoundary(props);
  boundary.setState = ((partial: object) => {
    boundary.state = { ...boundary.state, ...partial };
  }) as typeof boundary.setState;
  return boundary;
}

function simulateThrow(boundary: ErrorBoundary, error: unknown) {
  boundary.setState(ErrorBoundary.getDerivedStateFromError());
  boundary.componentDidCatch(error, {
    componentStack: "\n    at Boom",
  } as ErrorInfo);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ErrorBoundary", () => {
  it("renders its children while nothing has thrown", () => {
    const boundary = mount({
      name: "Test",
      children: <p>healthy panel</p>,
      fallback: () => <p>fallback</p>,
    });
    expect(renderToStaticMarkup(<>{boundary.render()}</>)).toBe(
      "<p>healthy panel</p>",
    );
  });

  it("swaps a throwing child for the fallback, logs the details, never renders them", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const boundary = mount({
      name: "Run history",
      children: <Boom />,
      fallback: (reset) => (
        <PanelErrorFallback title="Run history" onRetry={reset} />
      ),
    });

    // The child really throws when rendered — that is what the boundary catches.
    expect(() => renderToStaticMarkup(<>{boundary.render()}</>)).toThrow();
    simulateThrow(boundary, new Error("secret internal detail at /srv/app/stack.ts:42"));

    const html = renderToStaticMarkup(<>{boundary.render()}</>);
    expect(html).toContain("Run history");
    expect(html).toContain("couldn&#x27;t be");
    expect(html).toContain("Try again");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("secret internal detail");
    expect(html).not.toContain("stack.ts");

    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0]?.[0])).toContain("Run history");
  });

  it("still shows the fallback for a falsy thrown value", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const boundary = mount({
      name: "Test",
      children: <p>healthy panel</p>,
      fallback: () => <p>fallback</p>,
    });
    simulateThrow(boundary, null);
    expect(renderToStaticMarkup(<>{boundary.render()}</>)).toBe(
      "<p>fallback</p>",
    );
  });

  it("reset (the Try again handler) re-renders the children", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let retry: (() => void) | undefined;
    const boundary = mount({
      name: "Test",
      children: <p>healthy panel</p>,
      fallback: (reset) => {
        retry = reset;
        return <p>fallback</p>;
      },
    });
    simulateThrow(boundary, new Error("boom"));
    expect(renderToStaticMarkup(<>{boundary.render()}</>)).toBe(
      "<p>fallback</p>",
    );

    // The fallback received the boundary's own reset; calling it recovers.
    expect(retry).toBe(boundary.reset);
    retry?.();
    expect(boundary.state.failed).toBe(false);
    expect(renderToStaticMarkup(<>{boundary.render()}</>)).toBe(
      "<p>healthy panel</p>",
    );
  });
});

describe("AppErrorFallback", () => {
  it("says what failed and offers a reload, with no error details", () => {
    const html = renderToStaticMarkup(<AppErrorFallback />);
    expect(html).toContain("Something went wrong");
    expect(html).toContain("Reload page");
    expect(html).toContain('role="alert"');
  });
});
