import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AskPanel } from "../../../../features/answers";
import { SessionNav } from "../../../../features/auth";
import { requireSession } from "../../../../server/session.server";

export const metadata: Metadata = { title: "Ask · ContextVault" };

export default async function AskPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { workspaces } = await requireSession();
  // Navigation only; the API authorises every request itself.
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) notFound();
  return (
    <div className="mx-auto flex min-h-dvh max-w-3xl flex-col px-6 sm:px-8">
      <header className="flex items-center justify-between py-6">
        <Link href="/workspace" className="font-mono text-sm font-semibold tracking-tight">
          ContextVault
        </Link>
        <SessionNav />
      </header>
      <main className="flex-1 pb-12">
        <h1 className="mb-1 text-2xl font-semibold tracking-tight">{workspace.name}</h1>
        <Link href={`/workspace/${workspace.id}`} className="mb-6 inline-block text-sm underline">
          ← Documents
        </Link>
        <AskPanel workspaceId={workspace.id} />
      </main>
    </div>
  );
}
