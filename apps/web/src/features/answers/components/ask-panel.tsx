"use client";

import type { AnswerResponse, CitationResponse } from "@contextvault/contracts";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { askQuestion } from "../api";
import { askErrorMessage } from "../messages";

const abstainText = {
  no_evidence: "No document in this workspace is related to that question.",
  not_supported: "The documents do not contain enough evidence to answer that.",
} as const;

function CitationItem({ citation, index }: { citation: CitationResponse; index: number }) {
  return (
    <li className="rounded-card border border-line bg-surface p-3">
      <details>
        <summary className="cursor-pointer text-sm font-medium">
          <span className="font-mono text-muted">[{index}]</span> {citation.displayName}{" "}
          <span className="text-muted">
            · characters {citation.startOffset}–{citation.endOffset}
          </span>
        </summary>
        {/* Document text is untrusted: plain text only, never markup or links. */}
        <blockquote className="mt-2 whitespace-pre-wrap border-l-2 border-line pl-3 text-sm text-muted">
          {citation.excerpt}
        </blockquote>
      </details>
    </li>
  );
}

function Result({ result }: { result: AnswerResponse }) {
  if (result.kind === "insufficient_evidence") {
    return (
      <div data-testid="abstention" className="rounded-card border border-line p-4">
        <p className="font-medium">Insufficient evidence</p>
        <p className="mt-1 text-sm text-muted">{abstainText[result.reason]}</p>
      </div>
    );
  }
  return (
    <div data-testid="answer" className="space-y-4">
      <p className="whitespace-pre-wrap rounded-card border border-line p-4">{result.text}</p>
      <section aria-label="Sources">
        <h2 className="text-sm font-semibold">Sources</h2>
        <ul className="mt-2 space-y-2">
          {result.citations.map((c, i) => (
            <CitationItem key={c.chunkId} citation={c} index={i + 1} />
          ))}
        </ul>
      </section>
      <p className="text-xs text-muted">Answered by {result.model}</p>
    </div>
  );
}

export function AskPanel({ workspaceId }: { workspaceId: string }) {
  const [question, setQuestion] = useState("");
  const ask = useMutation({ mutationFn: (q: string) => askQuestion(workspaceId, q) });
  const text = question.trim();

  return (
    <div className="space-y-6">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (text !== "" && !ask.isPending) ask.mutate(text);
        }}
        className="space-y-3"
      >
        <label htmlFor="question" className="block text-sm font-medium">
          Ask your documents
        </label>
        <textarea
          id="question"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          maxLength={1000}
          rows={3}
          className="w-full rounded-lg border border-line bg-surface p-3"
          placeholder="What is the refund policy?"
        />
        <button
          type="submit"
          disabled={text === "" || ask.isPending}
          className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-canvas disabled:opacity-50"
        >
          {ask.isPending ? "Searching…" : "Ask"}
        </button>
      </form>
      <div role="status" aria-live="polite">
        {ask.isError ? (
          <p className="text-sm text-ink" data-testid="ask-error">
            {askErrorMessage(ask.error)}
          </p>
        ) : null}
        {ask.isSuccess ? <Result result={ask.data} /> : null}
      </div>
    </div>
  );
}
