"use client";

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto max-w-md px-6 py-24">
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p role="alert" className="mt-3 text-muted">
        The page could not be loaded. Try again in a moment.
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-6 rounded-card border border-line bg-surface px-4 py-2 font-medium"
      >
        Try again
      </button>
    </main>
  );
}
