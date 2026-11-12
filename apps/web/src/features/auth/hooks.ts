import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type Credentials, login, logout } from "./api";
import { sessionKey, sessionQueryOptions } from "./queries";

export const useSession = () => useQuery(sessionQueryOptions);

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (credentials: Credentials) => login(credentials),
    // Drop anything a previous user left in this tab, then await the session so navigation is safe.
    onSuccess: () => {
      queryClient.clear();
      return queryClient.invalidateQueries({ queryKey: sessionKey });
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: logout,
    // Only on success: a failed logout must not look signed out. Everything cached belongs to the
    // user who just left.
    onSuccess: () => {
      queryClient.clear();
      queryClient.setQueryData(sessionQueryOptions.queryKey, null);
    },
  });
}
