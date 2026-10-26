const principles = [
  {
    title: "Cited answers",
    body: "Every claim resolves to a source span the reader is authorised to see.",
  },
  {
    title: "Abstain, don't guess",
    body: "When the evidence is insufficient, the answer is an explicit abstention.",
  },
  {
    title: "Measured, not asserted",
    body: "Retrieval and chunking strategies are compared on fixed corpora with labelled queries.",
  },
] as const;

export default function Page() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-5xl flex-col px-6 sm:px-8">
      <header className="flex items-center justify-between py-6">
        <span className="font-mono text-sm font-semibold tracking-tight">ContextVault</span>
        <span className="rounded-full border border-line px-3 py-1 text-xs text-muted">
          Pre-release
        </span>
      </header>

      <main className="flex-1">
        <section className="py-16 sm:py-24" aria-labelledby="hero-title">
          <p className="font-mono text-sm text-accent">Evidence-first retrieval</p>
          <h1
            id="hero-title"
            className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-6xl"
          >
            Answers you can trace to the source.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-muted text-pretty">
            ContextVault is a workbench for ingesting technical documents, comparing keyword,
            vector and hybrid retrieval, and returning answers whose citations point at the exact
            passage, or saying so when the evidence is not there.
          </p>
        </section>

        <section className="pb-16 sm:pb-24" aria-labelledby="principles-title">
          <h2 id="principles-title" className="text-sm font-semibold text-muted">
            Design principles
          </h2>
          <ul className="mt-4 grid gap-4 sm:grid-cols-3">
            {principles.map((item) => (
              <li
                key={item.title}
                className="rounded-card border border-line bg-surface p-6"
              >
                <h3 className="font-semibold">{item.title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted">{item.body}</p>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="border-t border-line py-6 text-sm text-muted">
        Under construction. Nothing here is a live feature or a benchmark result yet.
      </footer>
    </div>
  );
}
