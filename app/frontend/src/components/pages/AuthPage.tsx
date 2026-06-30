import { useState, type FormEvent } from "react";
import { useLogin, useSignup } from "@/hooks/useAuth";
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

export function AuthPage() {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const login = useLogin();
  const signup = useSignup();
  const active = mode === "login" ? login : signup;

  // Callback-form mutate is intentional here (non-async handler): success
  // writes the ["me"] cache which flips AuthGate; errors surface via active.error.
  const submit = (e: FormEvent) => {
    e.preventDefault();
    active.mutate({ email, password });
  };

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sprout Automator</CardTitle>
          <CardDescription>
            {mode === "login"
              ? "Sign in to your account"
              : "Create your account"}
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
              {active.error ? (
                <Alert variant="destructive">
                  <AlertTitle>
                    {mode === "login" ? "Login failed" : "Sign up failed"}
                  </AlertTitle>
                  <AlertDescription>
                    {active.error instanceof Error
                      ? active.error.message
                      : "Something went wrong"}
                  </AlertDescription>
                </Alert>
              ) : null}
              <Button type="submit" disabled={active.isPending}>
                {active.isPending
                  ? "Please wait…"
                  : mode === "login"
                    ? "Sign in"
                    : "Sign up"}
              </Button>
            </FieldGroup>
          </form>
          <Button
            variant="link"
            className="mt-2 w-full"
            onClick={() => setMode(mode === "login" ? "signup" : "login")}
          >
            {mode === "login"
              ? "Need an account? Sign up"
              : "Have an account? Sign in"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
