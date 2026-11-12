import type { SearchMode, SearchResult } from "@contextvault/contracts";
import Link from "next/link";
import type { ModeOutcome } from "../api";
import { isSessionEnded } from "../messages";
import { MODE_NOTE, MODE_TITLE, outcomeText, scoreLines } from "../model";

function ResultItem({
  result,
  position,
  mode,
}: {
  result: SearchResult;
  position: number;
  mode: SearchMode;
}) {
  return (
    <li className="rounded-card border border-line bg-surface p-3" data-testid="search-result">
      <p className="break-words text-sm font-medium">
        <span className="font-mono text-muted">#{position}</span> {result.displayName}{" "}
        <span className="text-muted">
          · characters {result.startOffset}–{result.endOffset}
        </span>
      </p>
      {/* Document text is untrusted: plain text only, never markup or links. */}
      <p className="mt-2 whitespace-pre-wrap break-words text-sm">{result.content}</p>
      <dl className="mt-2 space-y-0.5 text-xs text-muted">
        {scoreLines(result, mode).map((line) => (
          <div key={line.label} className="flex flex-wrap gap-x-2">
            <dt>{line.label}:</dt>
            <dd className="tabular-nums">{line.value}</dd>
          </div>
        ))}
      </dl>
    </li>
  );
}

export function ModeResults({ outcome }: { outcome: ModeOutcome }) {
  const { mode } = outcome;
  const headingId = `search-${mode}`;
  return (
    <section
      aria-labelledby={headingId}
      data-testid={`results-${mode}`}
      className="min-w-0 space-y-2"
    >
      <h2 id={headingId} className="text-sm font-semibold">
        {MODE_TITLE[mode]}
      </h2>
      <p className="text-xs text-muted">{MODE_NOTE[mode]}</p>
      {/* Announced once by the panel's live region, not here. */}
      <p className="text-sm" data-testid={outcome.ok ? undefined : "search-error"}>
        {outcomeText(outcome)}
        {!outcome.ok && isSessionEnded(outcome.error) ? (
          <Link href="/login" className="ml-1 underline">
            Sign in again
          </Link>
        ) : null}
      </p>
      {outcome.ok ? (
        <ol className="space-y-2">
          {outcome.response.results.map((result, index) => (
            <ResultItem key={result.chunkId} result={result} position={index + 1} mode={mode} />
          ))}
        </ol>
      ) : null}
    </section>
  );
}
