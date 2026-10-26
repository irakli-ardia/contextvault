import { loadWebEnv } from "@contextvault/config";
import type { NextConfig } from "next";

// Same-origin API: the browser only talks to the web origin, so session cookies stay host-only
// and the API needs no CORS. The destination is one fixed origin read at build time; `:path*`
// can only extend the path, never change the host, so this is not an open proxy.
const { API_INTERNAL_URL } = loadWebEnv();

const config: NextConfig = {
  poweredByHeader: false,
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_INTERNAL_URL}/:path*` }];
  },
};

export default config;
