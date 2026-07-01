import { useState } from "react";
import { useStartRun } from "@/hooks/useRuns";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LogIn, LogOut } from "lucide-react";

export function ManualRunPanel() {
  const startRun = useStartRun();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const trigger = async (action: "in" | "out") => {
    setBusy(true);
    setMsg(null);
    try {
      await startRun.mutateAsync(action);
      setMsg("Run started — watch the history below.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Run now</CardTitle>
        <CardDescription>
          Trigger a one-off clock action against HRHub.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-3">
          <Button onClick={() => trigger("in")} disabled={busy}>
            <LogIn data-icon="inline-start" />
            Clock in now
          </Button>
          <Button
            variant="outline"
            onClick={() => trigger("out")}
            disabled={busy}
          >
            <LogOut data-icon="inline-start" />
            Clock out now
          </Button>
        </div>
        {msg ? (
          <span className="text-sm text-muted-foreground">{msg}</span>
        ) : null}
      </CardContent>
    </Card>
  );
}
