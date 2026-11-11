import { parseBytes } from "./parse-bytes";
import { ParseFailure } from "./parse-failure";

// The body of the isolated child, shared by the worker's built entry and the tests. It answers with
// a code or a document and nothing else: no error text, which may quote the document.
export async function runChild(
  input: AsyncIterable<Uint8Array>,
  write: (line: string) => void,
): Promise<void> {
  const parts: Uint8Array[] = [];
  for await (const chunk of input) parts.push(chunk);
  try {
    write(JSON.stringify({ ok: true, document: await parseBytes(Buffer.concat(parts)) }));
  } catch (error) {
    const code = error instanceof ParseFailure ? error.code : "parse.corrupt";
    write(JSON.stringify({ ok: false, code }));
  }
}
