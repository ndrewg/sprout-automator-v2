import {
  useMutation,
  useQuery,
  useQueryClient,
  type Query,
} from "@tanstack/react-query";
import { api, type Run } from "@/api";

export function useRuns(limit: number) {
  return useQuery<{ runs: Run[]; hasMore: boolean }>({
    // The limit is part of the key, NOT a separate infinite-query page: useRuns
    // polls adaptively, and merged infinite-query pages race the refresh — every
    // tick refetches every page. One keyed query refetches as a unit (phase 9B).
    queryKey: ["runs", limit],
    queryFn: async () => api.listRuns(limit),
    // Adaptive polling: tighten while any run is active.
    refetchInterval: (query: Query<{ runs: Run[]; hasMore: boolean }>) => {
      const runs = query.state.data?.runs;
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
