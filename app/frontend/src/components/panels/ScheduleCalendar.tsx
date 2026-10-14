import { useEffect, useMemo, useRef, useState } from "react";
import { Calendar, CalendarDayButton } from "@/components/ui/calendar";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  useClearScheduleDay,
  useScheduleDays,
  useSetScheduleDay,
} from "@/hooks/useSchedule";
import type { DayView } from "@/api";

// The day calendar (phase 16C). A month view of the Workday gate's decisions,
// with the user's own overrides layered on top. It renders ENTIRELY from
// `GET /schedule/days` — the browser never re-implements the gate, so the
// calendar and the 05:30 automation always agree.
//
// Accessibility (phase 16C contract): every state is more than a colour — each
// kind has its own cell treatment AND a legend AND an accessible name on the
// day button, so it is usable with colour vision deficiency and by a screen
// reader. The day grid is react-day-picker's, so arrow-key navigation works;
// the day's actions live in a popover whose close returns focus to the day.

/** "YYYY-MM-DD" from a LOCAL Date (the calendar's dates are local midnights). */
function toIso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** "YYYY-MM-DD" -> a LOCAL Date at midnight (the inverse of `toIso`). */
function toLocalDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}

/** The 1st of the month containing `iso`, as a local Date. */
function monthStart(iso: string): Date {
  return toLocalDate(`${iso.slice(0, 8)}01`);
}

function addMonths(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

/** The last day of `date`'s month, as an ISO string. */
function monthEndIso(date: Date): string {
  return toIso(new Date(date.getFullYear(), date.getMonth() + 1, 0));
}

/** "2026-11-02" -> "Mon 2 Nov 2026". */
function prettyDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(y!, m! - 1, d!));
}

/** The one-line human explanation of a day, used in the legend, the tooltip and
 *  the popover — so all three can never disagree. */
function describeDay(day: DayView | undefined): string {
  if (!day) return "No data for this day";
  switch (day.reason.code) {
    case "holiday":
      return `Holiday: ${day.reason.label}`;
    case "weekend":
      return "Weekend — no clock scheduled";
    case "paused":
      return "Paused — no clock scheduled";
    case "skip_day":
      return "Your skip day — no clock scheduled";
    case "work_override":
      return `You work this day — ${day.reason.label}`;
    default:
      return day.work ? "Work day — clocking in and out" : "No clock scheduled";
  }
}

export function ScheduleCalendar({ today }: { today: string }) {
  const [month, setMonth] = useState<Date>(() => monthStart(today));
  const [selected, setSelected] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const setDay = useSetScheduleDay();
  const clearDay = useClearScheduleDay();

  const from = toIso(month);
  const to = monthEndIso(month);
  const { data: days = [], isLoading } = useScheduleDays(from, to);

  const byDate = useMemo(
    () => new Map(days.map((d) => [d.date, d])),
    [days],
  );

  // Distinct, accessible cell treatments. Colour ALONE is never the signal:
  // a legend names each one, and every day button carries an aria-label.
  const modifiers = useMemo(
    () => ({
      weekendMod: days
        .filter((d) => d.reason.code === "weekend")
        .map((d) => toLocalDate(d.date)),
      holidayMod: days
        .filter((d) => d.reason.code === "holiday")
        .map((d) => toLocalDate(d.date)),
      skipMod: days
        .filter((d) => d.override?.kind === "skip")
        .map((d) => toLocalDate(d.date)),
      workMod: days
        .filter((d) => d.override?.kind === "work")
        .map((d) => toLocalDate(d.date)),
      pausedMod: days
        .filter((d) => d.reason.code === "paused")
        .map((d) => toLocalDate(d.date)),
    }),
    [days],
  );

  const modifiersClassNames = {
    // "Muted", not "faint": /60 opacity failed the contrast check (2.29:1).
    weekendMod: "text-muted-foreground",
    // The holiday wash keeps the DEFAULT foreground: destructive-red text on a
    // /10 destructive background measured 4.0:1 and failed the contrast check.
    // The signal is the wash + the solid outline + the legend + the aria-label.
    holidayMod:
      "bg-destructive/10 text-foreground outline-1 outline-solid outline-destructive",
    skipMod: "[&>button]:line-through bg-muted",
    workMod: "bg-primary/15 text-primary",
    pausedMod: "outline-dashed outline-1 outline-muted-foreground/40 bg-muted",
  };

  const selectedDay = selected ? byDate.get(selected) : undefined;
  const selectedIsPast = selected !== null && selected < today;
  const selectedOverride = selectedDay?.override ?? null;
  const saving = setDay.isPending || clearDay.isPending;

  // Keyboard: focusing the day's button when the popover opens, and putting
  // focus back on it when the popover closes (phase 16C: "focus returns to the
  // day after closing"). The button is found by the stable data attribute the
  // custom DayButton stamps on it, so this works for every close path — the
  // Close button, Escape, and an outside click.
  const lastSelected = useRef<string | null>(null);
  useEffect(() => {
    const target = selected ?? lastSelected.current;
    if (selected) lastSelected.current = selected;
    if (!target) return;
    if (!selected) lastSelected.current = null;
    document
      .querySelector<HTMLButtonElement>(`[data-day-iso="${target}"]`)
      ?.focus();
  }, [selected]);

  const close = (): void => setSelected(null);

  const runAction = async (
    fn: () => Promise<unknown>,
    okMessage: string,
  ): Promise<void> => {
    setMsg(null);
    try {
      await fn();
      setMsg(okMessage);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Calendar
        mode="single"
        month={month}
        onMonthChange={setMonth}
        selected={selected ? toLocalDate(selected) : undefined}
        onSelect={(date) => {
          setMsg(null);
          setSelected(date ? toIso(date) : null);
        }}
        showOutsideDays={false}
        className="mx-auto w-fit rounded-lg border [--cell-size:2.25rem] sm:[--cell-size:2.5rem]"
        modifiers={modifiers}
        modifiersClassNames={modifiersClassNames}
        components={{
          DayButton: (props) => {
            const iso = toIso(props.day.date);
            const info = byDate.get(iso);
            const label = `${prettyDate(iso)} — ${describeDay(info)}`;
            return (
              <CalendarDayButton
                {...props}
                data-day-iso={iso}
                aria-label={label}
                title={describeDay(info)}
              />
            );
          },
        }}
      />

      <ul
        className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground"
        aria-label="Calendar legend"
      >
        <li className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="size-3 rounded-[4px] border border-destructive bg-destructive/10"
          />
          Holiday
        </li>
        <li className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="flex size-3 items-center justify-center rounded-[4px] border border-input bg-muted"
          >
            <span className="h-px w-1.5 bg-current" />
          </span>
          Your skip day
        </li>
        <li className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="size-3 rounded-[4px] border border-primary/40 bg-primary/15"
          />
          You work this day
        </li>
        <li className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="size-3 rounded-[4px] border border-dashed border-muted-foreground/60 bg-muted"
          />
          Paused
        </li>
        <li className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="size-3 rounded-[4px] border border-transparent bg-muted-foreground/20"
          />
          Weekend
        </li>
      </ul>

      {isLoading ? <Skeleton className="h-10 w-full" /> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setMonth((m) => addMonths(m, -1))}
          aria-label="Previous month"
        >
          Previous month
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setMonth((m) => addMonths(m, 1))}
          aria-label="Next month"
        >
          Next month
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setMonth(monthStart(today))}
        >
          This month
        </Button>
        <span className="text-sm text-muted-foreground" aria-live="polite">
          {msg}
        </span>
      </div>

      <Popover
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <PopoverAnchor asChild>
          <span aria-hidden className="sr-only" />
        </PopoverAnchor>
        <PopoverContent
          aria-label="Day details"
          onCloseAutoFocus={(event) => {
            // "focus returns to the day after closing".
            event.preventDefault();
            if (selected) {
              document
                .querySelector<HTMLButtonElement>(`[data-day-iso="${selected}"]`)
                ?.focus();
            }
          }}
        >
          <PopoverHeader>
            <PopoverTitle>{selected ? prettyDate(selected) : ""}</PopoverTitle>
            <PopoverDescription>{describeDay(selectedDay)}</PopoverDescription>
          </PopoverHeader>

          <div className="flex flex-wrap items-center gap-2">
            {selectedOverride ? (
              <Badge variant="secondary">
                {selectedOverride.kind === "skip"
                  ? "Skip override"
                  : "Work override"}
              </Badge>
            ) : (
              <Badge variant="outline">
                {selectedDay?.work ? "Clocking" : "No clock"}
              </Badge>
            )}
          </div>

          <Separator />

          {selectedIsPast ? (
            <p className="text-muted-foreground">
              Past days can&apos;t be changed.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {!selectedOverride && selectedDay?.work ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={saving}
                  onClick={() =>
                    void runAction(
                      () => setDay.mutateAsync({ date: selected!, kind: "skip" }),
                      "Marked as a skip day.",
                    )
                  }
                >
                  Skip this day
                </Button>
              ) : null}
              {!selectedOverride && selectedDay && !selectedDay.work ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={saving}
                  onClick={() =>
                    void runAction(
                      () => setDay.mutateAsync({ date: selected!, kind: "work" }),
                      "Marked as a workday.",
                    )
                  }
                >
                  Work this day
                </Button>
              ) : null}
              {selectedOverride ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={saving}
                  onClick={() =>
                    void runAction(
                      () => clearDay.mutateAsync(selected!),
                      "Override cleared.",
                    )
                  }
                >
                  Clear override
                </Button>
              ) : null}
              <Button type="button" size="sm" variant="ghost" onClick={close}>
                Close
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
