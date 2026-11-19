// A created PDF has exactly the pages its content fills: the footer stamped on
// every page after layout must not push pdfkit onto a new, blank page.
// Footers drawn inside the bottom margin did, so every PDF ended with as many
// blank pages as it had real ones (2026-11-18).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { pdfTools } from "./pdf-tools.js";

const dir = mkdtempSync(join(tmpdir(), "lax-pdf-pages-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const pdf = pdfTools.find((t) => t.name === "pdf")!;

async function pagesOf(name: string, content: string, extra: Record<string, unknown> = {}): Promise<number> {
  const fp = join(dir, name);
  const r = await pdf.execute({ action: "create", file_path: fp, content, ...extra });
  expect(r.isError, String(r.content)).toBeFalsy();
  expect(r.metadata?.layoutProblems, String(r.content)).toBeUndefined();
  return (await PDFDocument.load(readFileSync(fp))).getPageCount();
}

describe("pdf create page count", () => {
  it("a short document is one page", async () => {
    expect(await pagesOf("short.pdf", "# Title\n\nOne paragraph.", { title: "Short" })).toBe(1);
  });

  it("a long document has only its own pages, each footer giving the true total", async () => {
    const para = "This sentence repeats to fill the page with body text. ".repeat(12);
    const content = Array.from({ length: 30 }, (_, i) => `## Section ${i + 1}\n\n${para}`).join("\n\n");
    const count = await pagesOf("long.pdf", content, { title: "Long" });
    const read = await pdf.execute({ action: "read", file_path: join(dir, "long.pdf") });
    // Every page carries its footer, and the last says the true total.
    expect(String(read.content)).toContain(`Page ${count} of ${count}`);
    expect(String(read.content)).not.toContain(`Page ${count + 1}`);
    expect(count).toBeGreaterThan(1);
  });
});
