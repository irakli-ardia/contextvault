"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useId } from "react";
import { useLogin } from "../hooks";
import { loginErrorMessage } from "./login-form-model";

const field = "mt-1 block w-full rounded-card border border-line bg-surface px-3 py-2 text-ink";

export function LoginForm() {
  const router = useRouter();
  const login = useLogin();
  const errorId = useId();

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = form.get("email");
    const password = form.get("password");
    if (typeof email !== "string" || typeof password !== "string") return;
    login.mutate(
      { email: email.trim(), password },
      {
        onSuccess: () => {
          router.replace("/workspace");
          router.refresh();
        },
      },
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4"
      aria-describedby={login.isError ? errorId : undefined}
    >
      <div>
        <label htmlFor="email" className="text-sm font-medium">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          maxLength={320}
          className={field}
        />
      </div>
      <div>
        <label htmlFor="password" className="text-sm font-medium">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          maxLength={1024}
          className={field}
        />
      </div>
      <p id={errorId} role="alert" className="min-h-6 text-sm text-ink">
        {login.isError ? loginErrorMessage(login.error) : null}
      </p>
      <button
        type="submit"
        disabled={login.isPending || login.isSuccess}
        className="w-full rounded-card bg-ink px-4 py-2 font-medium text-canvas disabled:opacity-60"
      >
        {login.isPending || login.isSuccess ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
