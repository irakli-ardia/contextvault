import type { Metadata } from "next";
import { AskPanel } from "../../../../features/answers";
import { WorkspaceFrame } from "../workspace-frame";

export const metadata: Metadata = { title: "Ask · ContextVault" };

export default function AskPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  return (
    <WorkspaceFrame params={params} maxWidth="max-w-3xl" backToDocuments>
      {(workspace) => <AskPanel workspaceId={workspace.id} />}
    </WorkspaceFrame>
  );
}
