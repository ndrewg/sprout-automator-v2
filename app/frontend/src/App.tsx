import { AuthGate } from "./components/AuthGate";
import { AppBoundary } from "./components/ErrorBoundary";

// The app-level boundary (BACKLOG §19) turns an uncaught render error anywhere
// below into a sentence + reload button instead of a white screen. Each
// dashboard panel has its own boundary too, so this is the last resort.
export default function App() {
  return (
    <AppBoundary>
      <AuthGate />
    </AppBoundary>
  );
}
