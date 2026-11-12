import type { Metadata } from "next";
import Link from "next/link";
import { DocumentLibrary } from "../../../features/documents";
import { WorkspaceFrame } from "./workspace-frame";

export const metadata: Metadata = { title: "Documents · ContextVault" };

export default function WorkspaceDocumentsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  return (
    <WorkspaceFrame params={params} maxWidth="max-w-5xl">
      {(workspace) => (
        <>
          <nav aria-label="Workspace tools" className="mb-6 flex gap-4 text-sm">
            <Link href={`/workspace/${workspace.id}/ask`} className="underline">
              Ask your documents →
            </Link>
            <Link href={`/workspace/${workspace.id}/search`} className="underline">
              Retrieval Lab →
            </Link>
          </nav>
          <DocumentLibrary workspaceId={workspace.id} />
        </>
      )}
    </WorkspaceFrame>
  );
}
