import { StageFailure } from "@contextvault/domain";

export const parseErrorCodes = [
  "parse.encrypted",
  "parse.corrupt",
  "parse.too_many_pages",
  "parse.text_too_large",
  "parse.no_text",
  "parse.invalid_encoding",
  "parse.timeout",
] as const;
export type ParseErrorCode = (typeof parseErrorCodes)[number];

/**
 * A verdict on the document. Repeating the parse gives the same answer, so none is retryable:
 * a bomb or a hang is deterministic, and the manual retry endpoint remains for the operator.
 */
export class ParseFailure extends StageFailure {
  constructor(
    override readonly code: ParseErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, false, options);
  }
}
