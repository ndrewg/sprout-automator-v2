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
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { CircleCheck, Eye, EyeOff, HelpCircle, TriangleAlert } from "lucide-react";

function RevealInput({
  id,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <InputGroup>
      <InputGroupInput
        id={id}
        type={show ? "text" : "password"}
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          type="button"
          size="icon-xs"
          aria-label={show ? "Hide" : "Show"}
          onClick={() => setShow((s) => !s)}
        >
          {show ? <EyeOff /> : <Eye />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}

export function CredentialsPanel() {
  const { data, isLoading } = useCredentials();
  const update = useUpdateCredentials();
  const testImap = useTestImap();

  const [sproutUsername, setSproutUsername] = useState("");
  const [sproutPassword, setSproutPassword] = useState("");
  const [gmailEmail, setGmailEmail] = useState("");
  const [gmailAppPassword, setGmailAppPassword] = useState("");
  const [sproutMsg, setSproutMsg] = useState<string | null>(null);
  const [gmailMsg, setGmailMsg] = useState<string | null>(null);
  const [savingSprout, setSavingSprout] = useState(false);
  const [savingGmail, setSavingGmail] = useState(false);
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

  const saveSprout = async () => {
    setSavingSprout(true);
    setSproutMsg(null);
    const patch: Record<string, string | null> = {};
    if (sproutUsername !== (data?.sproutUsername ?? "")) {
      patch.sproutUsername = sproutUsername ? sproutUsername : null;
    }
    if (sproutPassword) patch.sproutPassword = sproutPassword;
    if (Object.keys(patch).length === 0) {
      setSproutMsg("No changes.");
      setSavingSprout(false);
      return;
    }
    try {
      await update.mutateAsync(patch);
      setSproutPassword("");
      setSproutMsg("Saved.");
    } catch (e) {
      setSproutMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingSprout(false);
    }
  };

  const saveGmail = async () => {
    setSavingGmail(true);
    setGmailMsg(null);
    const patch: Record<string, string | null> = {};
    if (gmailEmail !== (data?.gmailEmail ?? "")) {
      patch.gmailEmail = gmailEmail ? gmailEmail : null;
    }
    if (gmailAppPassword) patch.gmailAppPassword = gmailAppPassword;
    if (Object.keys(patch).length === 0) {
      setGmailMsg("No changes.");
      setSavingGmail(false);
      return;
    }
    try {
      await update.mutateAsync(patch);
      setGmailAppPassword("");
      setGmailMsg("Saved.");
    } catch (e) {
      setGmailMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingGmail(false);
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
    <div className="flex flex-col gap-6">
      {/* Sprout HRHub card */}
      <Card>
        <CardHeader>
          <CardTitle>Sprout HRHub</CardTitle>
          <CardDescription>
            Your HRHub login, stored encrypted. Save applies to this card only.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <>
              <FieldGroup>
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
                  <RevealInput
                    id="sproutPassword"
                    value={sproutPassword}
                    onChange={setSproutPassword}
                    placeholder={
                      data?.sproutPasswordSet ? "(unchanged)" : "Enter password"
                    }
                  />
                </Field>
              </FieldGroup>
              <div className="flex items-center gap-3">
                <Button onClick={saveSprout} disabled={savingSprout}>
                  {savingSprout ? "Saving…" : "Save Sprout credentials"}
                </Button>
                {sproutMsg ? (
                  <span className="text-sm text-muted-foreground">
                    {sproutMsg}
                  </span>
                ) : null}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Gmail card */}
      <Card>
        <CardHeader>
          <CardTitle>Gmail (for OTP retrieval)</CardTitle>
          <CardDescription>
            Used to read the one-time code during a run. Save applies to this
            card only.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <>
              <FieldGroup>
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
                  <RevealInput
                    id="gmailAppPassword"
                    value={gmailAppPassword}
                    onChange={setGmailAppPassword}
                    placeholder={
                      data?.gmailAppPasswordSet
                        ? "(unchanged)"
                        : "abcd efgh ijkl mnop"
                    }
                  />
                  <FieldDescription>
                    Not your normal Google password — a 16-character App
                    Password. Spaces are fine.
                  </FieldDescription>
                </Field>
              </FieldGroup>

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
                        <strong>Save Gmail credentials</strong>.
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
                <Button variant="outline" onClick={test} disabled={testDisabled}>
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

              <div className="flex items-center gap-3">
                <Button onClick={saveGmail} disabled={savingGmail}>
                  {savingGmail ? "Saving…" : "Save Gmail credentials"}
                </Button>
                {gmailMsg ? (
                  <span className="text-sm text-muted-foreground">
                    {gmailMsg}
                  </span>
                ) : null}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
