import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type CredentialsView } from "@/api";

export function useCredentials() {
  return useQuery<CredentialsView>({
    queryKey: ["credentials"],
    queryFn: async () => (await api.getCredentials()).credentials,
  });
}

export function useUpdateCredentials() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Record<string, string | null>) =>
      api.putCredentials(patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["credentials"] }),
  });
}

export function useTestImap() {
  return useMutation({
    mutationFn: () => api.testImap(),
  });
}
