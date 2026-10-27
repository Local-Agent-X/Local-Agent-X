// The index holds a document's text as a read would show it: a PDF's words,
// an HTML page without its markup.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — no type declarations for pdfkit
import PDFDocument from "pdfkit";
import { documentText, isDocumentFile } from "./extract.js";

const dir = mkdtempSync(join(tmpdir(), "lax-doc-extract-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function writePdf(path: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const out = createWriteStream(path);
    out.on("finish", () => resolve());
    out.on("error", reject);
    doc.pipe(out);
    doc.text(text);
    doc.end();
  });
}

describe("documentText", () => {
  it("extracts a PDF's text", async () => {
    const pdf = join(dir, "contract.pdf");
    await writePdf(pdf, "Termination requires ninety days written notice.");
    expect(await documentText(pdf)).toContain("ninety days written notice");
  });

  it("strips an HTML page's markup", async () => {
    const html = join(dir, "page.html");
    writeFileSync(html, "<html><body><h1>Launch</h1><p>Ships in <b>May</b> &amp; June.</p></body></html>");
    const text = await documentText(html);
    expect(text).toContain("Ships in May & June.");
    expect(text).not.toContain("<");
  });

  it("knows which files are documents", () => {
    expect(["a.pdf", "b.DOCX", "c.md", "d.csv", "e.pptx", "f.html"].every(isDocumentFile)).toBe(true);
    expect(["a.exe", "b.png", "c.zip", "d.ts"].some(isDocumentFile)).toBe(false);
  });
});
