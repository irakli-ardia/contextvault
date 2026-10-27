import { describe, expect, it } from "vitest";
import { sanitizeFileName } from "./filename";

describe("sanitizeFileName", () => {
  it.each([
    ["report.PDF", "report.PDF", "application/pdf"],
    ["notes.md", "notes.md", "text/markdown"],
    ["a.TxT", "a.TxT", "text/plain"],
    ["../../etc/passwd.txt", "passwd.txt", "text/plain"],
    ["C:\\Users\\x\\cv.pdf", "cv.pdf", "application/pdf"],
    ["  spaced \t  out .md ", "spaced out .md", "text/markdown"],
    ["ნიმუში.pdf", "ნიმუში.pdf", "application/pdf"],
    ["re\u202Eport\u200B.pdf\u0007", "report.pdf", "application/pdf"],
    ["e\u0301.txt", "\u00e9.txt", "text/plain"],
    [`${"ა".repeat(83)}.pdf`, `${"ა".repeat(83)}.pdf`, "application/pdf"], // 253 bytes
    [`${"ა".repeat(84)}.md`, `${"ა".repeat(84)}.md`, "text/markdown"], // exactly 255 bytes
    [`${"a".repeat(252)}.md`, `${"a".repeat(252)}.md`, "text/markdown"], // exactly 255 bytes
  ])("%j -> %j", (raw, name, mime) => {
    expect(sanitizeFileName(raw)).toEqual({ name, mime });
  });

  it.each([
    "",
    ".",
    "..",
    ".pdf",
    " .pdf",
    "x.exe",
    "x.pdf.exe",
    "noextension",
    "dir/",
    "x.pdf/",
    "\u0000.pdf",
    `${"a".repeat(253)}.md`,
    `${"ა".repeat(85)}.md`, // 258 bytes
    `${"ა".repeat(90)}.pdf`,
  ])("rejects %j", (raw) => {
    expect(() => sanitizeFileName(raw)).toThrowError(
      expect.objectContaining({ code: "upload.invalid_name" }),
    );
  });
});
