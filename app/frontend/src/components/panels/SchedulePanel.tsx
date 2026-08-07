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
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";

/** dateStr "YYYY-MM-DD" + days, keeping the result in the same format. */
function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

/** "2026-08-14" -> "14 Aug" (for the pause banner). */
function formatManilaDay(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
  }).format(new Date(Date.UTC(y!, m! - 1, d!)));
}

export function SchedulePanel() {
  const { data, isLoading } = useSchedule();
  const update = useUpdateSchedule();
  const [clockInTime, setClockInTime] = useState("05:30");
  const [clockOutTime, setClockOutTime] = useState("18:05");
  const [enabled, setEnabled] = useState(false);
  // "" means "no pause"; the pair is always filled together (the API rejects
  // one-sided windows). Send null to clear.
  const [pausedFrom, setPausedFrom] = useState("");
  const [pausedUntil, setPausedUntil] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) {
      setClockInTime(data.clockInTime.slice(0, 5));
      setClockOutTime(data.clockOutTime.slice(0, 5));
      setEnabled(data.enabled);
      setPausedFrom(data.pausedFrom ?? "");
      setPausedUntil(data.pausedUntil ?? "");
    }
  }, [data]);

  const save = async (overrides?: {
    pausedFrom: string;
    pausedUntil: string;
  }) => {
    const from = overrides?.pausedFrom ?? pausedFrom;
    const until = overrides?.pausedUntil ?? pausedUntil;
    if ((from === "") !== (until === "")) {
      setMsg("Set both pause dates, or neither.");
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      await update.mutateAsync({
        clockInTime,
        clockOutTime,
        enabled,
        pausedFrom: from === "" ? null : from,
        pausedUntil: until === "" ? null : until,
      });
      setMsg("Saved.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const skipTomorrow = () => {
    if (!data) return;
    // Tomorrow's Manila date comes from the server — never the browser's local
    // date, which is in the wrong timezone for a travelling colleague.
    const tomorrow = addDays(data.today.date, 1);
    setPausedFrom(tomorrow);
    setPausedUntil(tomorrow);
    void save({ pausedFrom: tomorrow, pausedUntil: tomorrow });
  };

  const clearPause = () => {
    setPausedFrom("");
    setPausedUntil("");
    void save({ pausedFrom: "", pausedUntil: "" });
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
            {data?.pausedToday && data.pausedUntil ? (
              <Alert variant="warning">
                <AlertTitle>Paused</AlertTitle>
                <AlertDescription>
                  Auto-runs are paused until {formatManilaDay(data.pausedUntil)}.
                  You can still clock in manually.
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

            <FieldGroup>
              <FieldLabel className="font-medium">Pause auto-runs</FieldLabel>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="pausedFrom">Pause from</FieldLabel>
                  <Input
                    id="pausedFrom"
                    type="date"
                    value={pausedFrom}
                    onChange={(e) => setPausedFrom(e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="pausedUntil">Pause until</FieldLabel>
                  <Input
                    id="pausedUntil"
                    type="date"
                    value={pausedUntil}
                    onChange={(e) => setPausedUntil(e.target.value)}
                  />
                </Field>
              </div>
              <FieldDescription>
                Suppress auto clock in/out for these days — leave, a shutdown, an
                offsite. The window expires on its own, and manual clock in/out
                still works.
              </FieldDescription>
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="outline" type="button" onClick={skipTomorrow}>
                  Skip tomorrow
                </Button>
                <Button variant="ghost" type="button" onClick={clearPause}>
                  Clear pause
                </Button>
              </div>
            </FieldGroup>

            <div className="flex items-center gap-3">
              <Button onClick={() => save()} disabled={saving}>
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
