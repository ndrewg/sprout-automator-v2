import {
  useMutation,
  useQuery,
  useQueryClient,
  type Query,
} from "@tanstack/react-query";
import { api, type Run } from "@/api";

export function useRuns() {
  return useQuery<Run[]>({
    queryKey: ["runs"],
    queryFn: async () => (await api.listRuns()).runs,
    // Adaptive polling: tighten while any run is active.
    refetchInterval: (query: Query<Run[]>) => {
      const runs = query.state.data;
      const active = runs?.some(
        (r) => r.status === "pending" || r.status === "running",
      );
      return active ? 1500 : 5000;
    },
  });
}

export function useStartRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: "in" | "out") => api.startRun(action),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["runs"] }),
  });
}

export function useSubmitOtp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ runId, code }: { runId: string; code: string }) =>
      api.submitOtp(runId, code),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["runs"] }),
  });
}
