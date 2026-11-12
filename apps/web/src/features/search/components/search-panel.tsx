"use client";

import { useState } from "react";
import { useSearch } from "../hooks";
import { liveStatus, type ModeChoice } from "../model";
import { SearchForm } from "./search-form";
import { SearchResults } from "./search-results";

export function SearchPanel({ workspaceId }: { workspaceId: string }) {
  const [query, setQuery] = useState("");
  const [choice, setChoice] = useState<ModeChoice>("hybrid");
  const search = useSearch(workspaceId);
  const text = query.trim();
  const shown = search.isSuccess ? search.variables : null;

  return (
    <div className="space-y-6">
      <SearchForm
        query={query}
        choice={choice}
        pending={search.isPending}
        empty={text === ""}
        onQuery={setQuery}
        onChoice={setChoice}
        onSubmit={() => {
          if (text !== "" && !search.isPending) search.mutate({ query: text, choice });
        }}
      />
      {/* The only live region: always mounted so screen readers announce changes in it. */}
      <div role="status" aria-live="polite" className="sr-only">
        {liveStatus(search.isPending, search.data)}
      </div>
      {shown !== null && search.data !== undefined ? (
        <SearchResults
          outcomes={search.data}
          shown={shown}
          stale={shown.query !== text || shown.choice !== choice}
        />
      ) : null}
    </div>
  );
}
