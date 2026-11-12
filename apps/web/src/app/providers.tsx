"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { HttpError } from "../lib/http-client";

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // A 4xx answer will not change by asking again; transport and 5xx faults get one retry.
        retry: (count, error) => count < 1 && !(error instanceof HttpError && error.status < 500),
      },
    },
  });
}

// One client per browser tab: state keeps it alive across renders and never shares it between requests.
export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(makeQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
