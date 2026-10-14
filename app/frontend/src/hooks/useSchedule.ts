import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type DayView, type ScheduleView } from "@/api";

export function useSchedule() {
  return useQuery<ScheduleView>({
    queryKey: ["schedule"],
    queryFn: async () => (await api.getSchedule()).schedule,
  });
}

export function useUpdateSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: {
      clockInTime?: string;
      clockOutTime?: string;
      enabled?: boolean;
      pausedFrom?: string | null;
      pausedUntil?: string | null;
    }) => api.putSchedule(patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedule"] }),
  });
}

/**
 * One month (or any range, capped server-side at 92 days) of the Workday gate's
 * decisions, plus the user's own day overrides. The calendar renders from this
 * one call — the frontend NEVER re-implements the gate.
 */
export function useScheduleDays(from: string, to: string) {
  return useQuery<DayView[]>({
    queryKey: ["schedule-days", from, to],
    queryFn: async () => (await api.getScheduleDays(from, to)).days,
  });
}

function invalidateDayQueries(qc: ReturnType<typeof useQueryClient>): void {
  // The day list AND the "today" answer (which a same-day override changes).
  void qc.invalidateQueries({ queryKey: ["schedule-days"] });
  void qc.invalidateQueries({ queryKey: ["schedule"] });
}

export function useSetScheduleDay() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { date: string; kind: "skip" | "work"; note?: string }) =>
      api.putScheduleDay(input.date, { kind: input.kind, note: input.note }),
    onSuccess: () => invalidateDayQueries(qc),
  });
}

export function useClearScheduleDay() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (date: string) => api.deleteScheduleDay(date),
    onSuccess: () => invalidateDayQueries(qc),
  });
}
