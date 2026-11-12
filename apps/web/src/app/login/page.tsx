import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginForm } from "../../features/auth";
import { getServerSession } from "../../server/session.server";

export const metadata: Metadata = { title: "Sign in · ContextVault" };

export default async function LoginPage() {
  if ((await getServerSession()) !== null) redirect("/workspace");
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 py-12">
      <p className="font-mono text-sm text-accent">ContextVault</p>
      <h1 className="mt-2 mb-6 text-2xl font-semibold tracking-tight">Sign in</h1>
      <LoginForm />
    </main>
  );
}
