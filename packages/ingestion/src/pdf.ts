import { getDocumentProxy } from "unpdf";
import { parseLimits } from "./limits";
import { ParseFailure } from "./parse-failure";
import type { PageSpan, ParsedDocument } from "./parsed-document";

// pdf.js names its exceptions; only a password prompt is a verdict other than "corrupt".
const classify = (error: unknown): ParseFailure =>
  new ParseFailure(
    error instanceof Error && error.name === "PasswordException"
      ? "parse.encrypted"
      : "parse.corrupt",
  );

type PdfDocument = Awaited<ReturnType<typeof getDocumentProxy>>;

async function openPdf(bytes: Uint8Array): Promise<PdfDocument> {
  try {
    // pdf.js rejects a Buffer (the child reads stdin into one); a plain view needs no copy.
    return await getDocumentProxy(
      new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      {
        useSystemFonts: false,
        disableFontFace: true,
        verbosity: 0,
      },
    );
  } catch (error) {
    throw classify(error);
  }
}

async function pageText(pdf: PdfDocument, page: number): Promise<string> {
  const content = await (await pdf.getPage(page)).getTextContent();
  let text = "";
  for (const item of content.items) {
    if (!("str" in item)) continue;
    text += item.str + (item.hasEOL ? "\n" : "");
    // Stop inside the page: one page must not grow without bound before the total is checked.
    if (text.length > parseLimits.maxChars) throw new ParseFailure("parse.text_too_large");
  }
  return text.replaceAll("\0", "").toWellFormed();
}

// Text only: no rendering, no font loading, no script evaluation. The page count is checked before
// any page is read, and extraction stops at the first page that passes the character limit. The
// document is not destroyed: the permission model denies pdf.js's teardown, and the child exits.
export async function parsePdf(bytes: Uint8Array): Promise<ParsedDocument> {
  const pdf = await openPdf(bytes);
  if (pdf.numPages > parseLimits.maxPages) throw new ParseFailure("parse.too_many_pages");
  let text = "";
  const pages: PageSpan[] = [];
  try {
    for (let page = 1; page <= pdf.numPages; page += 1) {
      const next = await pageText(pdf, page);
      const start = text.length === 0 ? 0 : text.length + 1;
      if (start + next.length > parseLimits.maxChars)
        throw new ParseFailure("parse.text_too_large");
      text = text.length === 0 ? next : `${text}\n${next}`;
      pages.push({ page, start, end: start + next.length });
    }
  } catch (error) {
    throw error instanceof ParseFailure ? error : classify(error);
  }
  if (text.trim() === "") throw new ParseFailure("parse.no_text");
  return { format: "pdf", text, pages };
}
