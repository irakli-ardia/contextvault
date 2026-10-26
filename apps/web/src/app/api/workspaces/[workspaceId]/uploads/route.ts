import { loadWebEnv } from "@contextvault/config";
import { proxyUpload } from "../../../../../server/upload-proxy";

// Only POST exists: other methods get Next's 405. The route is a filesystem route, so it wins
// over the `/api/*` rewrite only because that rewrite runs in the `fallback` phase.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const { workspaceId } = await context.params;
  return proxyUpload(request, workspaceId, {
    upstreamOrigin: loadWebEnv().API_INTERNAL_URL,
    fetch,
  });
}
