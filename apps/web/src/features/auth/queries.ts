import { queryOptions } from "@tanstack/react-query";
import { fetchSession } from "./api";

export const sessionKey = ["session"] as const;

// A minute: long enough to avoid refetch storms between navigations, short enough that a session
// revoked elsewhere shows up on the next focus refetch.
export const sessionQueryOptions = queryOptions({
  queryKey: sessionKey,
  queryFn: ({ signal }) => fetchSession(signal),
  staleTime: 60_000,
});
