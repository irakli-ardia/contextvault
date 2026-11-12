import { CHOICES, type ModeChoice } from "../model";

interface SearchFormProps {
  readonly query: string;
  readonly choice: ModeChoice;
  readonly empty: boolean;
  readonly pending: boolean;
  readonly onQuery: (query: string) => void;
  readonly onChoice: (choice: ModeChoice) => void;
  readonly onSubmit: () => void;
}

export function SearchForm(props: SearchFormProps) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
      className="space-y-3"
    >
      <label htmlFor="search-query" className="block text-sm font-medium">
        Search query
      </label>
      <input
        id="search-query"
        type="text"
        value={props.query}
        onChange={(event) => props.onQuery(event.target.value)}
        maxLength={1000}
        className="w-full rounded-lg border border-line bg-surface p-3"
        placeholder="broken sprockets"
      />
      <fieldset className="flex flex-wrap gap-x-4 gap-y-2">
        <legend className="mb-1 text-sm font-medium">Mode</legend>
        {CHOICES.map((option) => (
          <label key={option.value} className="flex items-center gap-2 py-1 text-sm">
            <input
              type="radio"
              name="mode"
              value={option.value}
              checked={props.choice === option.value}
              onChange={() => props.onChoice(option.value)}
              className="accent-accent"
            />
            {option.label}
          </label>
        ))}
      </fieldset>
      <button
        type="submit"
        // Not `disabled` while searching: that would drop keyboard focus from the button. The
        // panel's submit handler ignores a submit that arrives while a search is in flight.
        disabled={props.empty}
        aria-disabled={props.pending}
        className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-canvas disabled:opacity-50 aria-disabled:opacity-50"
      >
        {props.pending ? "Searching…" : "Search"}
      </button>
    </form>
  );
}
