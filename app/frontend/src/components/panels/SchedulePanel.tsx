import { useEffect, useState } from "react";
import { useSchedule, useUpdateSchedule } from "@/hooks/useSchedule";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";

export function SchedulePanel() {
  const { data, isLoading } = useSchedule();
  const update = useUpdateSchedule();
  const [clockInTime, setClockInTime] = useState("05:30");
  const [clockOutTime, setClockOutTime] = useState("18:05");
  const [enabled, setEnabled] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) {
      setClockInTime(data.clockInTime.slice(0, 5));
      setClockOutTime(data.clockOutTime.slice(0, 5));
      setEnabled(data.enabled);
    }
  }, [data]);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await update.mutateAsync({ clockInTime, clockOutTime, enabled });
      setMsg("Saved.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Schedule</CardTitle>
        <CardDescription>
          {data
            ? `Today ${data.today.date} · Asia/Manila · runs Mon–Fri`
            : "Automatic clock in/out, Mon–Fri"}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {isLoading ? (
          <Skeleton className="h-28 w-full" />
        ) : (
          <>
            {data?.today.holiday ? (
              <Alert variant="warning">
                <AlertTitle>PH holiday: {data.today.holiday}</AlertTitle>
                <AlertDescription>
                  Auto-runs are skipped today.
                </AlertDescription>
              </Alert>
            ) : null}
            <FieldGroup>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="clockIn">Clock in</FieldLabel>
                  <Input
                    id="clockIn"
                    type="time"
                    value={clockInTime}
                    onChange={(e) => setClockInTime(e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="clockOut">Clock out</FieldLabel>
                  <Input
                    id="clockOut"
                    type="time"
                    value={clockOutTime}
                    onChange={(e) => setClockOutTime(e.target.value)}
                  />
                </Field>
              </div>
              <Field orientation="horizontal">
                <Checkbox
                  id="enabled"
                  checked={enabled}
                  onCheckedChange={(v) => setEnabled(v === true)}
                />
                <FieldLabel htmlFor="enabled" className="font-normal">
                  Run automatically Mon–Fri
                </FieldLabel>
              </Field>
            </FieldGroup>
            <div className="flex items-center gap-3">
              <Button onClick={save} disabled={saving}>
                {saving ? "Saving…" : "Save schedule"}
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
