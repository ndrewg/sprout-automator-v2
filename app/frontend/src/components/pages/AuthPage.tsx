import { useState, type FormEvent } from "react";
import { useForgotPassword, useLogin, useSignup } from "@/hooks/useAuth";
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

// Login / signup / forgot-password card. The password-reset screen lives in
// ResetPasswordPage (its own URL /reset?token=…) and is rendered by AuthGate
// BEFORE this one, so it is reachable whether or not a session exists.

export function AuthPage() {
  const [mode, setMode] = useState<"login" | "signup" | "forgot">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const login = useLogin();
  const signup = useSignup();
  const forgot = useForgotPassword();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (mode === "forgot") {
      forgot.mutate(email);
      return;
    }
    if (mode === "login") {
      login.mutate({ email, password });
    } else {
      signup.mutate({ email, password });
    }
  };

  const isPending =
    mode === "forgot" ? forgot.isPending : mode === "login" ? login.isPending : signup.isPending;
  const error =
    mode === "forgot" ? forgot.error : mode === "login" ? login.error : signup.error;
  const showForgotSuccess = mode === "forgot" && forgot.isSuccess;

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sprout Automator</CardTitle>
          <CardDescription>
            {mode === "login"
              ? "Sign in to your account"
              : mode === "signup"
                ? "Create your account"
                : "Reset your password"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="email">Email</FieldLabel>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </Field>
              {mode !== "forgot" ? (
                <Field>
                  <FieldLabel htmlFor="password">Password</FieldLabel>
                  <Input
                    id="password"
                    type="password"
                    autoComplete={
                      mode === "login" ? "current-password" : "new-password"
                    }
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    minLength={12}
                    required
                  />
                  <FieldDescription>At least 12 characters.</FieldDescription>
                </Field>
              ) : null}
              {showForgotSuccess ? (
                <Alert variant="success">
                  <AlertTitle>Check your email</AlertTitle>
                  <AlertDescription>
                    If an account exists for that address, a password reset link
                    is on its way.
                  </AlertDescription>
                </Alert>
              ) : error ? (
                <Alert variant="destructive">
                  <AlertTitle>
                    {mode === "login"
                      ? "Login failed"
                      : mode === "signup"
                        ? "Sign up failed"
                        : "Couldn't send reset link"}
                  </AlertTitle>
                  <AlertDescription>
                    {error instanceof Error
                      ? error.message
                      : "Something went wrong"}
                  </AlertDescription>
                </Alert>
              ) : null}
              <Button type="submit" disabled={isPending}>
                {isPending
                  ? "Please wait…"
                  : mode === "login"
                    ? "Sign in"
                    : mode === "signup"
                      ? "Sign up"
                      : "Send reset link"}
              </Button>
            </FieldGroup>
          </form>
          <div className="mt-2 flex flex-col">
            {mode === "login" ? (
              <Button
                variant="link"
                className="w-full"
                onClick={() => {
                  setMode("forgot");
                  setEmail("");
                  setPassword("");
                }}
              >
                Forgot password?
              </Button>
            ) : null}
            {mode === "login" ? (
              <Button
                variant="link"
                className="w-full"
                onClick={() => setMode("signup")}
              >
                Need an account? Sign up
              </Button>
            ) : null}
            {mode === "signup" ? (
              <Button
                variant="link"
                className="w-full"
                onClick={() => setMode("login")}
              >
                Have an account? Sign in
              </Button>
            ) : null}
            {mode === "forgot" ? (
              <Button
                variant="link"
                className="w-full"
                onClick={() => setMode("login")}
              >
                Back to sign in
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
