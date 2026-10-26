import { loadWebEnv } from "@contextvault/config";
import type { NextConfig } from "next";

// Same-origin API: the browser only talks to the web origin, so session cookies stay host-only
// and the API needs no CORS. The rewrite destination is one fixed origin, read here when
// `next build` runs and then frozen in the build output: `next start` ignores a different value,
// and changing it needs a rebuild. `:path*` can only extend the path, never change the host, so
// this is not an open proxy.
// The streaming upload Route Handler is separate: it reads the same variable from the running
// server's environment, so a restart is enough for it. Keep the build and runtime values equal
// (ADR 0009).
const { API_INTERNAL_URL } = loadWebEnv();

const config: NextConfig = {
  poweredByHeader: false,
  async rewrites() {
    // `fallback`, not the default `afterFiles`: that phase runs before dynamic routes and would
    // shadow the streaming upload Route Handler (app/api/workspaces/[workspaceId]/uploads) with
    // this buffering proxy (ADR 0009).
    return { fallback: [{ source: "/api/:path*", destination: `${API_INTERNAL_URL}/:path*` }] };
  },
};

export default config;
