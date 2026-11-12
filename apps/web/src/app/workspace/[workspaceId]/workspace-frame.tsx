import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { SessionNav } from "../../../features/auth";
import { requireSession } from "../../../server/session.server";

interface WorkspaceFrameProps {
  readonly params: Promise<{ workspaceId: string }>;
  /** A Tailwind max-width class: the tool pages differ in width. */
  readonly maxWidth: string;
  /** Tool pages link back to the documents page under the title. */
  readonly backToDocuments?: boolean;
  readonly children: (workspace: { readonly id: string }) => ReactNode;
}

/** Shared shell of the workspace pages: session check, membership, header and title. */
export async function WorkspaceFrame({
  params,
  maxWidth,
  backToDocuments = false,
  children,
}: WorkspaceFrameProps) {
  const { workspaceId } = await params;
  const { workspaces } = await requireSession();
  // Navigation only; the API authorises every request itself.
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) notFound();
  return (
    <div className={`mx-auto flex min-h-dvh ${maxWidth} flex-col px-6 sm:px-8`}>
      <header className="flex items-center justify-between py-6">
        <Link href="/workspace" className="font-mono text-sm font-semibold tracking-tight">
          ContextVault
        </Link>
        <SessionNav />
      </header>
      <main className="flex-1 pb-12">
        <h1 className={`${backToDocuments ? "mb-1 " : ""}text-2xl font-semibold tracking-tight`}>
          {workspace.name}
        </h1>
        {backToDocuments ? (
          <Link href={`/workspace/${workspace.id}`} className="mb-6 inline-block text-sm underline">
            ← Documents
          </Link>
        ) : null}
        {children(workspace)}
      </main>
    </div>
  );
}
