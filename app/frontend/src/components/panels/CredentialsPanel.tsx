import { useEffect, useState } from "react";
import {
  useCredentials,
  useTestImap,
  useUpdateCredentials,
} from "@/hooks/useCredentials";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { CircleCheck, HelpCircle, TriangleAlert } from "lucide-react";

export function CredentialsPanel() {
  const { data, isLoading } = useCredentials();
  const update = useUpdateCredentials();
  const testImap = useTestImap();

  const [sproutUsername, setSproutUsername] = useState("");
  const [sproutPassword, setSproutPassword] = useState("");
  const [gmailEmail, setGmailEmail] = useState("");
  const [gmailAppPassword, setGmailAppPassword] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [testResult, setTestResult] = useState<
    { ok: true; count: number } | { ok: false; error: string } | null
  >(null);

  useEffect(() => {
    if (data) {
      setSproutUsername(data.sproutUsername ?? "");
      setGmailEmail(data.gmailEmail ?? "");
    }
  }, [data]);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    const patch: Record<string, string | null> = {};
    if (sproutUsername !== (data?.sproutUsername ?? "")) {
      patch.sproutUsername = sproutUsername ? sproutUsername : null;
    }
    if (sproutPassword) patch.sproutPassword = sproutPassword;
    if (gmailEmail !== (data?.gmailEmail ?? "")) {
      patch.gmailEmail = gmailEmail ? gmailEmail : null;
    }
    if (gmailAppPassword) patch.gmailAppPassword = gmailAppPassword;

    if (Object.keys(patch).length === 0) {
      setMsg("No changes.");
      setSaving(false);
      return;
    }
    try {
      await update.mutateAsync(patch);
      setSproutPassword("");
      setGmailAppPassword("");
      setMsg("Credentials saved.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTestResult(null);
    try {
      const res = await testImap.mutateAsync();
      if (res.ok) {
        setTestResult({ ok: true, count: res.messageCount ?? 0 });
      } else {
        setTestResult({ ok: false, error: res.error ?? "Connection failed." });
      }
    } catch (e) {
      setTestResult({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const testDisabled = testImap.isPending || !data?.gmailAppPasswordSet;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Credentials</CardTitle>
        <CardDescription>
          Stored encrypted. Passwords are never shown back to you.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <>
            {/* Sprout */}
            <FieldGroup>
              <h3 className="text-sm font-medium">Sprout HRHub</h3>
              <Field>
                <FieldLabel htmlFor="sproutUsername">Username</FieldLabel>
                <Input
                  id="sproutUsername"
                  autoComplete="off"
                  value={sproutUsername}
                  onChange={(e) => setSproutUsername(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="sproutPassword">
                  Password{" "}
                  {data?.sproutPasswordSet ? (
                    <Badge variant="success">set</Badge>
                  ) : null}
                </FieldLabel>
                <Input
                  id="sproutPassword"
                  type="password"
                  autoComplete="off"
                  placeholder={
                    data?.sproutPasswordSet ? "(unchanged)" : "Enter password"
                  }
                  value={sproutPassword}
                  onChange={(e) => setSproutPassword(e.target.value)}
                />
              </Field>
            </FieldGroup>

            <Separator />

            {/* Gmail */}
            <FieldGroup>
              <h3 className="text-sm font-medium">Gmail (for OTP retrieval)</h3>
              <Field>
                <FieldLabel htmlFor="gmailEmail">Gmail address</FieldLabel>
                <Input
                  id="gmailEmail"
                  type="email"
                  autoComplete="off"
                  value={gmailEmail}
                  onChange={(e) => setGmailEmail(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="gmailAppPassword">
                  App password{" "}
                  {data?.gmailAppPasswordSet ? (
                    <Badge variant="success">set</Badge>
                  ) : null}
                </FieldLabel>
                <Input
                  id="gmailAppPassword"
                  type="password"
                  autoComplete="off"
                  placeholder={
                    data?.gmailAppPasswordSet
                      ? "(unchanged)"
                      : "abcd efgh ijkl mnop"
                  }
                  value={gmailAppPassword}
                  onChange={(e) => setGmailAppPassword(e.target.value)}
                />
                <FieldDescription>
                  Not your normal Google password — a 16-character App Password.
                  Spaces are fine.
                </FieldDescription>
              </Field>

              <Button
                variant="link"
                className="w-fit px-0"
                onClick={() => setShowHelp((s) => !s)}
              >
                <HelpCircle data-icon="inline-start" />
                How do I set this up?
              </Button>

              {showHelp ? (
                <Alert variant="info">
                  <AlertTitle>Set up a Gmail App Password (~5 min)</AlertTitle>
                  <AlertDescription>
                    <ol className="ml-4 flex list-decimal flex-col gap-1">
                      <li>
                        Enable 2-Step Verification:{" "}
                        <a
                          href="https://myaccount.google.com/signinoptions/two-step-verification"
                          target="_blank"
                          rel="noreferrer"
                        >
                          myaccount.google.com/signinoptions/two-step-verification
                        </a>{" "}
                        → Get started → follow the prompts → confirm the green
                        check.
                      </li>
                      <li>
                        Generate an App Password:{" "}
                        <a
                          href="https://myaccount.google.com/apppasswords"
                          target="_blank"
                          rel="noreferrer"
                        >
                          myaccount.google.com/apppasswords
                        </a>{" "}
                        (only visible once 2-Step is on) → pick Mail + a device →
                        Generate → copy the 16-character code.
                      </li>
                      <li>
                        Paste it above (spaces are stripped server-side), click{" "}
                        <strong>Test Gmail connection</strong>, then{" "}
                        <strong>Save credentials</strong>.
                      </li>
                    </ol>
                  </AlertDescription>
                </Alert>
              ) : null}

              {showHelp ? (
                <Alert variant="warning">
                  <TriangleAlert />
                  <AlertTitle>Google shows the password only once</AlertTitle>
                  <AlertDescription>
                    Copy it before leaving the page — otherwise regenerate a new
                    one.
                  </AlertDescription>
                </Alert>
              ) : null}

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="outline"
                  onClick={test}
                  disabled={testDisabled}
                >
                  {testImap.isPending ? "Testing…" : "Test Gmail connection"}
                </Button>
                {!data?.gmailAppPasswordSet ? (
                  <span className="text-sm text-muted-foreground">
                    Save an app password first to test.
                  </span>
                ) : null}
              </div>

              {testResult?.ok ? (
                <Alert variant="success">
                  <CircleCheck />
                  <AlertTitle>Connected</AlertTitle>
                  <AlertDescription>
                    {testResult.count} message(s) in inbox.
                  </AlertDescription>
                </Alert>
              ) : null}
              {testResult && !testResult.ok ? (
                <Alert variant="destructive">
                  <TriangleAlert />
                  <AlertTitle>Invalid credentials</AlertTitle>
                  <AlertDescription>{testResult.error}</AlertDescription>
                </Alert>
              ) : null}
            </FieldGroup>

            <div className="flex items-center gap-3">
              <Button onClick={save} disabled={saving}>
                {saving ? "Saving…" : "Save credentials"}
              </Button>
              {msg ? (
                <span className="text-sm text-muted-foreground">{msg}</span>
              ) : null}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
