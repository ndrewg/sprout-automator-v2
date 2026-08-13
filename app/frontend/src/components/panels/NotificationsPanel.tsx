import { useEffect, useState } from "react";
import {
  useNotifications,
  useTestNotification,
  useUpdateNotifications,
} from "@/hooks/useNotifications";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Checkbox } from "@/components/ui/checkbox";
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

export function NotificationsPanel() {
  const { data, isLoading } = useNotifications();
  const update = useUpdateNotifications();
  const testNotification = useTestNotification();

  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [notifyOnSuccess, setNotifyOnSuccess] = useState(true);
  const [notifyOnFailure, setNotifyOnFailure] = useState(true);
  const [notifyOnSkipped, setNotifyOnSkipped] = useState(true);
  const [notifyOnMissed, setNotifyOnMissed] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [testResult, setTestResult] = useState<
    { ok: true; username: string } | { ok: false; error: string } | null
  >(null);

  useEffect(() => {
    if (data) {
      setChatId(data.telegramChatId ?? "");
      setEnabled(data.enabled);
      setNotifyOnSuccess(data.notifyOnSuccess);
      setNotifyOnFailure(data.notifyOnFailure);
      setNotifyOnSkipped(data.notifyOnSkipped);
      setNotifyOnMissed(data.notifyOnMissed);
    }
  }, [data]);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    // Partial patch: only send what actually changed. The bot token is sent
    // ONLY if the user typed one — never a masked placeholder.
    const patch: Record<string, string | boolean | null> = {};
    if (botToken) patch.telegramBotToken = botToken;
    if (chatId !== (data?.telegramChatId ?? "")) {
      patch.telegramChatId = chatId ? chatId : null;
    }
    if (enabled !== data?.enabled) patch.enabled = enabled;
    if (notifyOnSuccess !== data?.notifyOnSuccess) patch.notifyOnSuccess = notifyOnSuccess;
    if (notifyOnFailure !== data?.notifyOnFailure) patch.notifyOnFailure = notifyOnFailure;
    if (notifyOnSkipped !== data?.notifyOnSkipped) patch.notifyOnSkipped = notifyOnSkipped;
    if (notifyOnMissed !== data?.notifyOnMissed) patch.notifyOnMissed = notifyOnMissed;
    if (Object.keys(patch).length === 0) {
      setMsg("No changes.");
      setSaving(false);
      return;
    }
    try {
      await update.mutateAsync(patch);
      setBotToken("");
      setMsg("Saved.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTestResult(null);
    try {
      const res = await testNotification.mutateAsync();
      setTestResult({ ok: true, username: res.botUsername ?? "the bot" });
    } catch (e) {
      setTestResult({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const configured = (data?.telegramTokenSet ?? false) && !!data?.telegramChatId;
  const testDisabled = testNotification.isPending || !configured;
  const outcomesDisabled = !enabled;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Telegram notifications</CardTitle>
        <CardDescription>
          Get a message for every run — success, failure, skipped, or missed
          entirely.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <>
            <FieldGroup>
              <Field orientation="horizontal">
                <Checkbox
                  id="notifEnabled"
                  checked={enabled}
                  onCheckedChange={(v) => setEnabled(v === true)}
                />
                <FieldLabel htmlFor="notifEnabled" className="font-normal">
                  Send notifications
                </FieldLabel>
              </Field>
              {enabled && !configured ? (
                <FieldDescription>
                  You need a bot token and chat ID before enabling.
                </FieldDescription>
              ) : null}

              <Field>
                <FieldLabel htmlFor="botToken">
                  Bot token{" "}
                  {data?.telegramTokenSet ? (
                    <Badge variant="success">set</Badge>
                  ) : null}
                </FieldLabel>
                <RevealInput
                  id="botToken"
                  value={botToken}
                  onChange={setBotToken}
                  placeholder={
                    data?.telegramTokenSet
                      ? "(unchanged)"
                      : "123456789:AA…"
                  }
                />
                <FieldDescription>
                  From BotFather. Stored encrypted; only sent when you type a
                  new one.
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="chatId">Chat ID</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id="chatId"
                    type="text"
                    autoComplete="off"
                    value={chatId}
                    onChange={(e) => setChatId(e.target.value)}
                    placeholder="123456789 or -1001234567890"
                  />
                </InputGroup>
              </Field>

              <Field>
                <FieldLabel className="font-normal">Tell me about…</FieldLabel>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Field orientation="horizontal">
                    <Checkbox
                      id="notifyOnSuccess"
                      checked={notifyOnSuccess}
                      disabled={outcomesDisabled}
                      onCheckedChange={(v) => setNotifyOnSuccess(v === true)}
                    />
                    <FieldLabel
                      htmlFor="notifyOnSuccess"
                      className="font-normal"
                    >
                      Successes
                    </FieldLabel>
                  </Field>
                  <Field orientation="horizontal">
                    <Checkbox
                      id="notifyOnFailure"
                      checked={notifyOnFailure}
                      disabled={outcomesDisabled}
                      onCheckedChange={(v) => setNotifyOnFailure(v === true)}
                    />
                    <FieldLabel htmlFor="notifyOnFailure" className="font-normal">
                      Failures
                    </FieldLabel>
                  </Field>
                  <Field orientation="horizontal">
                    <Checkbox
                      id="notifyOnSkipped"
                      checked={notifyOnSkipped}
                      disabled={outcomesDisabled}
                      onCheckedChange={(v) => setNotifyOnSkipped(v === true)}
                    />
                    <FieldLabel htmlFor="notifyOnSkipped" className="font-normal">
                      Skipped
                    </FieldLabel>
                  </Field>
                  <Field orientation="horizontal">
                    <Checkbox
                      id="notifyOnMissed"
                      checked={notifyOnMissed}
                      disabled={outcomesDisabled}
                      onCheckedChange={(v) => setNotifyOnMissed(v === true)}
                    />
                    <FieldLabel htmlFor="notifyOnMissed" className="font-normal">
                      Missed runs
                    </FieldLabel>
                  </Field>
                </div>
                <FieldDescription>
                  A missed-run alert means the automation didn't run, not that
                  you weren't clocked in — clocking in by hand still triggers
                  one.
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
                <AlertTitle>Set up a Telegram bot (~5 min)</AlertTitle>
                <AlertDescription>
                  <ol className="ml-4 flex list-decimal flex-col gap-2">
                    <li>
                      <strong>Create the bot.</strong> Message{" "}
                      <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">
                        @BotFather
                      </a>{" "}
                      → send <strong>/newbot</strong> → give it any display name,
                      then a username ending in <code>bot</code>. It replies with
                      a token that looks like{" "}
                      <code>8123456789:AAF…</code>. Paste that above.
                    </li>
                    <li>
                      <strong>Message your new bot once.</strong> Open a chat with
                      it and send anything at all. Telegram does not let a bot
                      start a conversation, so until you do this every message
                      fails — it is the #1 cause of "chat not found".
                    </li>
                    <li>
                      <strong>Get your chat ID.</strong> Easiest: message{" "}
                      <a
                        href="https://t.me/userinfobot"
                        target="_blank"
                        rel="noreferrer"
                      >
                        @userinfobot
                      </a>
                      , which replies with your numeric ID straight away. Paste it
                      above.
                    </li>
                    <li>
                      Click <strong>Test connection</strong> — you should get a
                      message naming your bot — then <strong>Save</strong>.
                    </li>
                  </ol>
                  <p className="mt-3 text-muted-foreground">
                    <strong>Alternative for step 3:</strong> visit{" "}
                    <code>api.telegram.org/bot&lt;YOUR_TOKEN&gt;/getUpdates</code>{" "}
                    in a browser, replacing <code>&lt;YOUR_TOKEN&gt;</code> with
                    the real token and keeping the <code>bot</code> prefix, then
                    copy <code>chat.id</code>. That URL contains your token, so
                    treat it like a password and don't share it or leave it in
                    your history. A <code>404 Not Found</code> means the token in
                    the URL is wrong or still the placeholder.
                  </p>
                </AlertDescription>
              </Alert>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
              <Button variant="outline" onClick={test} disabled={testDisabled}>
                {testNotification.isPending ? "Testing…" : "Test connection"}
              </Button>
              <Button onClick={save} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
              {msg ? (
                <span className="text-sm text-muted-foreground">{msg}</span>
              ) : null}
            </div>

            {testResult?.ok ? (
              <Alert variant="success">
                <CircleCheck />
                <AlertTitle>Connected</AlertTitle>
                <AlertDescription>
                  Check Telegram — {testResult.username} sent you a message.
                </AlertDescription>
              </Alert>
            ) : null}
            {testResult && !testResult.ok ? (
              <Alert variant="destructive">
                <TriangleAlert />
                <AlertTitle>Test failed</AlertTitle>
                <AlertDescription>{testResult.error}</AlertDescription>
              </Alert>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
