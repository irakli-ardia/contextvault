import { runChild } from "@contextvault/ingestion/child";

// Entry of the isolated parser process (ADR 0011), built next to main.mjs. It never reads the
// environment: it is started with none.
await runChild(process.stdin, (line) => process.stdout.write(line, () => process.exit(0)));
