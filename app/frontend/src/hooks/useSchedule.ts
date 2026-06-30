import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ScheduleView } from "@/api";

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
    }) => api.putSchedule(patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedule"] }),
  });
}
