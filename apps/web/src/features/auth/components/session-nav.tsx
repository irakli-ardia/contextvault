"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLogout, useSession } from "../hooks";

const control = "rounded-full border border-line px-3 py-1 text-xs";

export function SessionNav() {
  const router = useRouter();
  const session = useSession();
  const logout = useLogout();

  // Same size as the controls that replace it, so the header does not shift.
  if (session.isPending) {
    return (
      <span className={`${control} invisible`} aria-hidden="true">
        Sign in
      </span>
    );
  }
  if (session.isError) {
    return (
      <span className="text-xs text-muted" role="status">
        Session unavailable
      </span>
    );
  }
  if (session.data === null) {
    return (
      <Link href="/login" className={control}>
        Sign in
      </Link>
    );
  }
  return (
    <div className="flex items-center gap-3 text-xs">
      <Link href="/workspace" className="text-muted underline">
        {session.data.user.email}
      </Link>
      <button
        type="button"
        disabled={logout.isPending}
        className={control}
        onClick={() =>
          logout.mutate(undefined, {
            onSuccess: () => {
              router.replace("/login");
              router.refresh();
            },
          })
        }
      >
        Sign out
      </button>
      {logout.isError ? (
        <span role="alert" className="text-muted">
          Sign-out failed. Try again.
        </span>
      ) : null}
    </div>
  );
}
