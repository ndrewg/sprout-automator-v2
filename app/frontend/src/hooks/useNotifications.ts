import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type NotificationSettingsView } from "@/api";

export function useNotifications() {
  return useQuery<NotificationSettingsView>({
    queryKey: ["notifications"],
    queryFn: async () => (await api.getNotifications()).settings,
  });
}

export function useUpdateNotifications() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Record<string, string | boolean | null>) =>
      api.putNotifications(patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
}

export function useTestNotification() {
  return useMutation({
    mutationFn: () => api.testNotification(),
  });
}
