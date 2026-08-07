import { useState } from "react";
import { useMe } from "@/hooks/useAuth";
import { AuthPage } from "./pages/AuthPage";
import { Dashboard } from "./pages/Dashboard";
import { ResetPasswordPage } from "./pages/ResetPasswordPage";

// Read the reset token ONLY from /reset?token=… — the pathname gate means a
// stray ?token= on any other page cannot hijack rendering.
function readResetToken(): string | null {
  if (window.location.pathname !== "/reset") return null;
  return new URLSearchParams(window.location.search).get("token");
}

export function AuthGate() {
  const { data: user, isLoading } = useMe();
  const [resetToken, setResetToken] = useState<string | null>(readResetToken);

  // The reset screen renders regardless of session state: a logged-in user who
  // opens a reset link must reach it (the reset deletes every session for that
  // user, so they end up logged out anyway). The token is held in state so a
  // successful reset can strip it from the URL without unmounting the screen.
  if (resetToken) {
    return (
      <ResetPasswordPage
        token={resetToken}
        onFinished={() => setResetToken(null)}
      />
    );
  }

  if (isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-muted-foreground">
        Loading…
      </div>
    );
  }

  return user ? <Dashboard user={user} /> : <AuthPage />;
}
