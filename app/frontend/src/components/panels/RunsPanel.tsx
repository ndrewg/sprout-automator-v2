import { Fragment, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useRuns, useSubmitOtp } from "@/hooks/useRuns";
import type { Run } from "@/api";
import { formatRunDate } from "@/lib/dates";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronRight, KeyRound } from "lucide-react";

const STATUS_VARIANT: Record<
  Run["status"],
  "success" | "info" | "destructive" | "warning" | "secondary"
> = {
  success: "success",
  skipped: "info",
  failure: "destructive",
  running: "warning",
  pending: "secondary",
};

// Start at 10 (the API default) and grow by 20 per "Show more" — the limit is
// ephemeral UI state; the rows stay owned by TanStack Query (AGENTS.md rule 12).
const INITIAL_LIMIT = 10;
const GROW_BY = 20;

function fmt(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function RunsPanel() {
  const [limit, setLimit] = useState(INITIAL_LIMIT);
  const { data, isLoading } = useRuns(limit);
  const submitOtp = useSubmitOtp();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [otpMsg, setOtpMsg] = useState<string | null>(null);

  const runs = data?.runs;
  const hasMore = data?.hasMore ?? false;
  // The formatter is pure and takes an injected clock; the panel supplies it
  // per render so relative labels stay correct as polling refetches.
  const now = new Date();
  const waiting = runs?.find((r) => r.waitingForOtp);

  const submit = async () => {
    if (!waiting) return;
    setOtpMsg(null);
    try {
      await submitOtp.mutateAsync({ runId: waiting.id, code });
      setCode("");
      setOtpMsg("Code submitted.");
    } catch (e) {
      setOtpMsg(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Run history</CardTitle>
        <CardDescription>Most recent runs (newest first).</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {waiting ? (
          <Alert variant="warning">
            <KeyRound />
            <AlertTitle>An OTP is required to continue</AlertTitle>
            <AlertDescription>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Input
                  className="w-40"
                  inputMode="numeric"
                  placeholder="12345"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
                <Button
                  size="sm"
                  onClick={submit}
                  disabled={submitOtp.isPending || code.length < 4}
                >
                  Submit OTP
                </Button>
                {otpMsg ? <span className="text-sm">{otpMsg}</span> : null}
              </div>
            </AlertDescription>
          </Alert>
        ) : null}

        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : !runs || runs.length === 0 ? (
          <Empty>
            <EmptyTitle>No runs yet</EmptyTitle>
            <EmptyDescription>
              Trigger one above or wait for the schedule.
            </EmptyDescription>
          </Empty>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="w-8 py-2" />
                    <th className="py-2 pr-4 font-medium">Action</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 pr-4 font-medium">Date</th>
                    <th className="py-2 pr-4 font-medium">Started</th>
                    <th className="py-2 pr-4 font-medium">Finished</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => {
                    const isOpen = expanded === run.id;
                    const steps = run.steps ?? [];
                    return (
                      // Fragment carries the key, not the <tr> inside it: the key
                      // must sit on the outermost element returned by map(), or
                      // React falls back to index reconciliation. That bites here
                      // — the list refetches every 1.5s while a run is active and
                      // new runs are inserted at the TOP, so every index shifts
                      // and the expanded detail row can attach to the wrong run.
                      <Fragment key={run.id}>
                        <tr
                          className="cursor-pointer border-b hover:bg-muted/50"
                          onClick={() => setExpanded(isOpen ? null : run.id)}
                        >
                          <td className="py-3 align-middle">
                            <ChevronRight
                              className={
                                "size-4 text-muted-foreground transition-transform " +
                                (isOpen ? "rotate-90" : "")
                              }
                            />
                          </td>
                          <td className="py-3 pr-4 uppercase">{run.action}</td>
                          <td className="py-3 pr-4">
                            <Badge variant={STATUS_VARIANT[run.status]}>
                              {run.status}
                            </Badge>
                          </td>
                          <td className="py-3 pr-4 tabular-nums">
                            <time dateTime={run.startedAt}>
                              {formatRunDate(run.startedAt, now)}
                            </time>
                          </td>
                          <td className="py-3 pr-4 tabular-nums">
                            {fmt(run.startedAt)}
                          </td>
                          <td className="py-3 pr-4 tabular-nums">
                            {fmt(run.finishedAt)}
                          </td>
                        </tr>
                        <AnimatePresence initial={false}>
                          {isOpen ? (
                            <tr key={`${run.id}-detail`}>
                              <td colSpan={6} className="p-0">
                                <motion.div
                                  initial={{ height: 0, opacity: 0 }}
                                  animate={{ height: "auto", opacity: 1 }}
                                  exit={{ height: 0, opacity: 0 }}
                                  transition={{ duration: 0.2 }}
                                  className="overflow-hidden"
                                >
                                  <div className="flex flex-col gap-1 bg-muted/30 px-4 py-3">
                                    {run.error ? (
                                      <p className="text-sm text-destructive">
                                        {run.error}
                                      </p>
                                    ) : null}
                                    {steps.length === 0 ? (
                                      <p className="text-sm text-muted-foreground">
                                        No steps recorded.
                                      </p>
                                    ) : (
                                      steps.map((s, i) => (
                                        <div
                                          key={i}
                                          className="flex flex-wrap gap-3 text-sm"
                                        >
                                          <span className="shrink-0 tabular-nums text-muted-foreground">
                                            {fmt(s.timestamp)}
                                          </span>
                                          <span className="min-w-0">
                                            {s.message}
                                          </span>
                                        </div>
                                      ))
                                    )}
                                  </div>
                                </motion.div>
                              </td>
                            </tr>
                          ) : null}
                        </AnimatePresence>
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">
                Showing {runs.length}
              </p>
              {hasMore ? (
                <Button
                  variant="outline"
                  className="w-full sm:w-auto"
                  onClick={() => setLimit((l) => l + GROW_BY)}
                >
                  Show more
                </Button>
              ) : null}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
