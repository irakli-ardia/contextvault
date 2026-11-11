// Minimal hand-built PDFs for the parser tests: one Helvetica string per page.
const escapeText = (text: string) =>
  text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");

export function buildPdf(
  pages: readonly string[],
  trailerExtra = "",
  objectExtra = "",
): Uint8Array {
  const objects: string[] = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((text, i) => {
    // pdf.js drops text that falls off the page, and does not read one very long literal in full.
    // Long text is therefore drawn tiny, in short strings that step down by almost nothing.
    const dense = text.length > 1000;
    const shown = (text.match(/[\s\S]{1,1000}/g) ?? [""])
      .map((s) => `(${escapeText(s)}) Tj${dense ? " 0 -0.0001 Td" : ""}`)
      .join(" ");
    const content = `BT /F1 ${dense ? 0.01 : 12} Tf 72 700 Td ${shown} ET`;
    objects[4 + i * 2] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
    objects[5 + i * 2] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i += 1) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  out += objectExtra;
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i += 1) {
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R ${trailerExtra} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const hex32 = "00".repeat(32);
/** Declares the Standard security handler with credentials that no password matches. */
export const buildEncryptedPdf = (): Uint8Array =>
  buildPdf(
    ["secret"],
    `/Encrypt << /Filter /Standard /V 1 /R 2 /O <${hex32}> /U <${hex32}> /P -4 >> /ID [<${hex32}> <${hex32}>]`,
  );
