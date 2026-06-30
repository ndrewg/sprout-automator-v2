import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type User } from "@/api";

type Credentials = { email: string; password: string };

export function useMe() {
  return useQuery<User>({
    queryKey: ["me"],
    queryFn: async () => (await api.me()).user,
    retry: false, // a 401 must not retry-storm
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ email, password }: Credentials) => api.login(email, password),
    onSuccess: (data) => qc.setQueryData(["me"], data.user),
  });
}

export function useSignup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ email, password }: Credentials) =>
      api.signup(email, password),
    onSuccess: (data) => qc.setQueryData(["me"], data.user),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => qc.clear(),
  });
}
