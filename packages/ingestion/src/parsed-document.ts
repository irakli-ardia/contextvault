import { z } from "zod";
import { parseLimits } from "./limits";

/** One PDF page: `[start, end)` are UTF-16 offsets into `text`. */
export interface PageSpan {
  readonly page: number;
  readonly start: number;
  readonly end: number;
}

/**
 * What the next stage receives. `text` has `\n` line endings, no BOM and no NUL. Markdown and TXT
 * are both `text`: the worker role cannot read `mime` (no grant, no migration in M1.5), so the
 * two are not told apart; Markdown is plain text until sections are derived in M1.6.
 */
export type ParsedDocument =
  | { readonly format: "text"; readonly text: string }
  | { readonly format: "pdf"; readonly text: string; readonly pages: readonly PageSpan[] };

// The contract above, enforced on the host: a compromised child skips its own sanitising.
const text = z
  .string()
  .min(1)
  .max(parseLimits.maxChars)
  .refine((value) => !/[\0\r]/.test(value) && !value.startsWith("\uFEFF") && value.isWellFormed());
const textDocument = z.object({ format: z.literal("text"), text }).strict();
const pdfDocument = z
  .object({
    format: z.literal("pdf"),
    text,
    pages: z
      .array(
        z
          .object({
            page: z.number().int().min(1),
            start: z.number().int().min(0),
            end: z.number().int().min(0),
          })
          .strict(),
      )
      .min(1)
      .max(parseLimits.maxPages),
  })
  .strict()
  .superRefine((doc, ctx) => {
    let cursor = 0;
    doc.pages.forEach((p, i) => {
      // Ordered, numbered from 1, inside the text, and never overlapping.
      if (p.page !== i + 1 || p.start < cursor || p.end < p.start || p.end > doc.text.length) {
        ctx.addIssue({ code: "custom", message: "pages" });
      }
      cursor = p.end;
    });
  });

/** The host validates what a child returns: a compromised child must not hand over anything else. */
export const parsedDocumentSchema = z.union([textDocument, pdfDocument]);
