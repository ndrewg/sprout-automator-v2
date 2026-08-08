import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type User } from "@/api";

type Credentials = { email: string; password: string };

export function useMe() {
  return useQuery<User>({
    queryKey: ["me"],
    queryFn: async () => (await api.me()).user,
    retry: false, // a 401 must not retry-storm
    // Re-checking the session on every tab-focus buys almost nothing — if it
    // died, the next real action 401s and the UI reacts — and it actively hurts:
    // while logged out this query has no data, so a refetch returns it to
    // `pending`, AuthGate renders its loading branch, and AuthPage unmounts
    // mid-typing. Found by alt-tabbing away from a half-filled login form.
    refetchOnWindowFocus: false,
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
    onSuccess: () => {
      // resetQueries() notifies subscribers AND resets the query data (refetching
      // active queries). clear() alone empties the cache but never notifies the
      // ["me"] observer in AuthGate, so it keeps its stale user and the Dashboard
      // never unmounts. /auth/me now refetches, 401s, and AuthGate flips to the
      // login page.
      qc.resetQueries();
    },
  });
}

export function useForgotPassword() {
  return useMutation({
    mutationFn: (email: string) => api.forgotPassword(email),
  });
}

export function useResetPassword() {
  return useMutation({
    mutationFn: ({ token, newPassword }: { token: string; newPassword: string }) =>
      api.resetPassword(token, newPassword),
  });
}

export function useVerifyEmail() {
  return useMutation({
    mutationFn: (token: string) => api.verifyEmail(token),
  });
}

export function useResendVerification() {
  return useMutation({
    mutationFn: () => api.resendVerification(),
  });
}
