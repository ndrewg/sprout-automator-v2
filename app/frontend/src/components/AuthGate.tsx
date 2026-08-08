import { useState } from "react";
import { useMe } from "@/hooks/useAuth";
import { AuthPage } from "./pages/AuthPage";
import { Dashboard } from "./pages/Dashboard";
import { ResetPasswordPage } from "./pages/ResetPasswordPage";
import { VerifyEmailPage } from "./pages/VerifyEmailPage";

// Read the reset token ONLY from /reset?token=… — the pathname gate means a
// stray ?token= on any other page cannot hijack rendering.
function readResetToken(): string | null {
  if (window.location.pathname !== "/reset") return null;
  return new URLSearchParams(window.location.search).get("token");
}

// Same gate for the verification link at /verify?token=….
function readVerifyToken(): string | null {
  if (window.location.pathname !== "/verify") return null;
  return new URLSearchParams(window.location.search).get("token");
}

export function AuthGate() {
  const { data: user, isLoading, isFetched } = useMe();
  const [resetToken, setResetToken] = useState<string | null>(readResetToken);
  const [verifyToken, setVerifyToken] = useState<string | null>(readVerifyToken);

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

  // The verify screen has the same property: the emailed link is normally
  // opened while the signup session is still alive, so it must render BEFORE
  // the auth branch too.
  if (verifyToken) {
    return (
      <VerifyEmailPage
        token={verifyToken}
        onFinished={() => setVerifyToken(null)}
      />
    );
  }

  // Only on the FIRST load. A logged-out ["me"] has no data, so any later
  // refetch returns it to `pending` and isLoading goes true again — rendering
  // this branch would unmount AuthPage and discard whatever the user had typed.
  // isFetched stays true once the query has settled even once, so a background
  // refetch keeps whichever screen is already on display.
  if (isLoading && !isFetched) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-muted-foreground">
        Loading…
      </div>
    );
  }

  return user ? <Dashboard user={user} /> : <AuthPage />;
}
