import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { type Account, expect } from "./support";

// Unique bytes per call: identical content is de-duplicated by the API.
export const markdown = (name: string) => ({
  name,
  mimeType: "text/markdown",
  buffer: Buffer.from(
    `# Retrieval notes\n\nChunking splits documents into passages. ${randomUUID()}\n`,
  ),
});

// A PDF whose Standard security handler no password matches: the parser reports parse.encrypted.
export function encryptedPdf(name: string) {
  const hex = "00".repeat(32);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 4\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size 4 /Root 1 0 R /Encrypt << /Filter /Standard /V 1 /R 2 /O <${hex}> /U <${hex}> /P -4 >> /ID [<${hex}> <${hex}>] >>\nstartxref\n${xref}\n%%EOF\n`;
  return { name, mimeType: "application/pdf", buffer: Buffer.from(out) };
}

export async function signInToLibrary(page: Page, account: Account) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/workspace$/);
  await page.getByRole("heading", { level: 2 }).first().getByRole("link").click();
  await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
}
