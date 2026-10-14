import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { TriangleAlert } from "lucide-react";

// BACKLOG §19: a render error used to be a white screen. React 19 still has
// no hook for catching render errors, so the boundary itself is a class
// component (no react-error-boundary dependency for ~30 lines).
//
// The fallbacks never show the error message or stack: those can carry
// internals the user can't act on. Details go to the console for whoever is
// debugging; the user gets one sentence naming what failed and a way out.

type ErrorBoundaryProps = {
  /** What this boundary wraps, for the console line ("Run history", "app"). */
  name: string;
  children: ReactNode;
  /** Rendered instead of `children` after a render error; `reset` retries. */
  fallback: (reset: () => void) => ReactNode;
};

type ErrorBoundaryState = { failed: boolean };

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { failed: false };

  // A boolean flag rather than the error itself: `throw null` is legal, and a
  // falsy error must still show the fallback.
  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(
      `[ErrorBoundary:${this.props.name}] render error`,
      error,
      info.componentStack,
    );
  }

  reset = () => {
    this.setState({ failed: false });
  };

  render() {
    if (this.state.failed) return this.props.fallback(this.reset);
    return this.props.children;
  }
}

/** Panel-level fallback: the rest of the dashboard keeps working. */
export function PanelErrorFallback({
  title,
  onRetry,
}: {
  title: string;
  onRetry: () => void;
}) {
  return (
    <Card role="alert">
      <CardContent className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 text-sm">
          <TriangleAlert className="size-4 shrink-0 text-destructive" />
          <span>
            <strong className="font-medium">{title}</strong> couldn't be
            displayed.
          </span>
        </div>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </CardContent>
    </Card>
  );
}

/** Wraps one dashboard panel so a crash in it doesn't blank the page. */
export function PanelBoundary({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <ErrorBoundary
      name={title}
      fallback={(reset) => <PanelErrorFallback title={title} onRetry={reset} />}
    >
      {children}
    </ErrorBoundary>
  );
}

/** Whole-app fallback: last line of defence, so a reload is the way out. */
export function AppErrorFallback() {
  return (
    <div
      role="alert"
      className="flex min-h-dvh flex-col items-center justify-center gap-4 p-4 text-center"
    >
      <TriangleAlert className="size-8 text-destructive" />
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="text-sm text-muted-foreground">
          Sprout Automator couldn't display this page. Your schedule keeps
          running on the server; reloading usually fixes this.
        </p>
      </div>
      <Button onClick={() => window.location.reload()}>Reload page</Button>
    </div>
  );
}

export function AppBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary name="app" fallback={() => <AppErrorFallback />}>
      {children}
    </ErrorBoundary>
  );
}
