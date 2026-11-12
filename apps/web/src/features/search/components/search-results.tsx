import type { ModeOutcome } from "../api";
import { CHOICES, type ModeChoice } from "../model";
import { ModeResults } from "./mode-results";

interface SearchResultsProps {
  readonly outcomes: readonly ModeOutcome[];
  readonly shown: { readonly query: string; readonly choice: ModeChoice };
  /** The controls no longer match what produced these results. */
  readonly stale: boolean;
}

export function SearchResults({ outcomes, shown, stale }: SearchResultsProps) {
  const label = CHOICES.find((option) => option.value === shown.choice)?.label;
  return (
    <div className="space-y-3">
      <p className="break-words text-sm" data-testid="search-context">
        Results for “{shown.query}” · {label}
        {stale ? (
          <strong className="font-medium">
            {" "}
            — the query or mode changed; search again to refresh.
          </strong>
        ) : null}
      </p>
      <div
        data-testid="search-results"
        data-stale={stale}
        className={`grid gap-4 ${outcomes.length > 1 ? "lg:grid-cols-3" : ""}`}
      >
        {outcomes.map((outcome) => (
          <ModeResults key={outcome.mode} outcome={outcome} />
        ))}
      </div>
    </div>
  );
}
