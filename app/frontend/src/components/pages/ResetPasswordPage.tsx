import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useResetPassword } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";

// The password-reset screen for /reset?token=… (served as index.html by the
// backend's SPA catch-all — no client router). Rendered by AuthGate BEFORE the
// auth branch so it works whether or not a session exists.

export function ResetPasswordPage({
  token,
  onFinished,
}: {
  token: string;
  onFinished: () => void;
}) {
  const [password, setPassword] = useState("");
  const [done, setDone] = useState(false);
  const reset = useResetPassword();
  const qc = useQueryClient();

  // Plain mutate() in a non-async handler (rule 12); the onSuccess flip keeps
  // the success card visible until the user chooses to return to the login form.
  const submit = (e: FormEvent) => {
    e.preventDefault();
    reset.mutate(
      { token, newPassword: password },
      {
        onSuccess: () => {
          // The token is spent — strip it from the URL so a refresh doesn't
          // re-present the form. AuthGate holds the token in state, so the
          // success card stays until the user leaves.
          window.history.replaceState(null, "", window.location.pathname);
          // The reset deleted every session for this user; refetch /auth/me so
          // AuthGate flips to the login form instead of a dead-session dashboard.
          qc.resetQueries({ queryKey: ["me"] });
          setDone(true);
        },
      },
    );
  };

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{done ? "Password updated" : "Reset your password"}</CardTitle>
          <CardDescription>
            {done
              ? "You can now sign in with your new password."
              : "Choose a new password for your account."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {done ? (
            <Button className="w-full" onClick={onFinished}>
              Sign in
            </Button>
          ) : (
            <form onSubmit={submit}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="new-password">New password</FieldLabel>
                  <Input
                    id="new-password"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    minLength={12}
                    required
                  />
                  <FieldDescription>At least 12 characters.</FieldDescription>
                </Field>
                {reset.error ? (
                  <Alert variant="destructive">
                    <AlertTitle>Reset failed</AlertTitle>
                    <AlertDescription>
                      {reset.error instanceof Error
                        ? reset.error.message
                        : "Something went wrong"}
                    </AlertDescription>
                  </Alert>
                ) : null}
                <Button type="submit" disabled={reset.isPending}>
                  {reset.isPending ? "Please wait…" : "Reset password"}
                </Button>
              </FieldGroup>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
