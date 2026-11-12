import type { Metadata } from "next";
import { SessionNav } from "../../features/auth";
import { requireSession } from "../../server/session.server";

export const metadata: Metadata = { title: "Workspace · ContextVault" };

export default async function WorkspacePage() {
  const { workspaces } = await requireSession();
  return (
    <div className="mx-auto flex min-h-dvh max-w-5xl flex-col px-6 sm:px-8">
      <header className="flex items-center justify-between py-6">
        <span className="font-mono text-sm font-semibold tracking-tight">ContextVault</span>
        <SessionNav />
      </header>
      <main className="flex-1">
        <h1 className="text-2xl font-semibold tracking-tight">Your workspaces</h1>
        <ul className="mt-4 grid gap-4 sm:grid-cols-2">
          {workspaces.map((workspace) => (
            <li key={workspace.id} className="rounded-card border border-line bg-surface p-6">
              <h2 className="font-semibold">{workspace.name}</h2>
              <p className="mt-1 text-sm text-muted">{workspace.role}</p>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
