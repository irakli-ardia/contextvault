import type { Metadata } from "next";
import { SearchPanel } from "../../../../features/search";
import { WorkspaceFrame } from "../workspace-frame";

export const metadata: Metadata = { title: "Retrieval Lab · ContextVault" };

export default function SearchPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  return (
    <WorkspaceFrame params={params} maxWidth="max-w-5xl" backToDocuments>
      {(workspace) => <SearchPanel workspaceId={workspace.id} />}
    </WorkspaceFrame>
  );
}
