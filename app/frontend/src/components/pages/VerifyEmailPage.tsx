import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useVerifyEmail } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

// The email-verification screen for /verify?token=… (served as index.html by
// the backend's SPA catch-all — no client router). Rendered by AuthGate BEFORE
// the auth branch so it works whether or not a session exists, mirroring the
// password-reset screen.

export function VerifyEmailPage({
  token,
  onFinished,
}: {
  token: string;
  onFinished: () => void;
}) {
  const [done, setDone] = useState(false);
  const verify = useVerifyEmail();
  const qc = useQueryClient();

  // Plain mutate() in a non-async handler (rule 12); the onSuccess flip keeps
  // the success card visible until the user chooses to continue.
  const submit = () => {
    verify.mutate(token, {
      onSuccess: () => {
        // The token is spent — strip it from the URL so a refresh doesn't
        // re-present the form. AuthGate holds the token in state, so the
        // success card stays until the user leaves.
        window.history.replaceState(null, "", window.location.pathname);
        // Refetch /auth/me so the dashboard (or the login page, if there was
        // no session) reflects the now-verified address.
        qc.resetQueries({ queryKey: ["me"] });
        setDone(true);
      },
    });
  };

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{done ? "Email verified" : "Verify your email"}</CardTitle>
          <CardDescription>
            {done
              ? "Thanks — your email address is confirmed."
              : "Confirm this address to finish setting up your account."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {done ? (
            <Button className="w-full" onClick={onFinished}>
              Continue
            </Button>
          ) : (
            <div className="flex flex-col gap-4">
              {verify.error ? (
                <Alert variant="destructive">
                  <AlertTitle>Verification failed</AlertTitle>
                  <AlertDescription>
                    {verify.error instanceof Error
                      ? verify.error.message
                      : "Something went wrong"}
                  </AlertDescription>
                </Alert>
              ) : null}
              <Button onClick={submit} disabled={verify.isPending}>
                {verify.isPending ? "Verifying…" : "Verify email"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
