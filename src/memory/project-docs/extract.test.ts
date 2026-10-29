// The index holds a document's text as a read would show it: a PDF's words,
// an HTML page without its markup. Text that exists only as pixels, an image
// or a scanned PDF page, is read by OCR.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, createWriteStream, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — no type declarations for pdfkit
import PDFDocument from "pdfkit";
import { documentText, isDocumentFile } from "./extract.js";
import { stopOcr } from "../../tools/ocr-tool.js";

const invoicePng = fileURLToPath(new URL("../../../test/fixtures/ocr-invoice.png", import.meta.url));

const dir = mkdtempSync(join(tmpdir(), "lax-doc-extract-"));
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await stopOcr();
});

function writePdf(path: string, draw: (doc: any) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const out = createWriteStream(path);
    out.on("finish", () => resolve());
    out.on("error", reject);
    doc.pipe(out);
    draw(doc);
    doc.end();
  });
}

describe("documentText", () => {
  it("extracts a PDF's text", async () => {
    const pdf = join(dir, "contract.pdf");
    await writePdf(pdf, (doc) => doc.text("Termination requires ninety days written notice."));
    expect(await documentText(pdf)).toContain("ninety days written notice");
  });

  it("strips an HTML page's markup", async () => {
    const html = join(dir, "page.html");
    writeFileSync(html, "<html><body><h1>Launch</h1><p>Ships in <b>May</b> &amp; June.</p></body></html>");
    const text = await documentText(html);
    expect(text).toContain("Ships in May & June.");
    expect(text).not.toContain("<");
  });

  it("reads the words in an image", async () => {
    const png = join(dir, "invoice.png");
    writeFileSync(png, readFileSync(invoicePng));
    expect(await documentText(png)).toMatch(/Invoice 4471 is due in March/i);
  }, 60_000);

  it("reads a scanned PDF page by OCR and keeps a text page's own words", async () => {
    const pdf = join(dir, "scan.pdf");
    await writePdf(pdf, (doc) => {
      doc.text("Cover letter for the quarterly filing.");
      doc.addPage();
      doc.image(invoicePng, 50, 50, { width: 500 });
    });
    const text = await documentText(pdf);
    expect(text).toContain("Cover letter for the quarterly filing.");
    expect(text).toMatch(/Invoice 4471 is due in March/i);
  }, 120_000);

  it("knows which files are documents", () => {
    expect(["a.pdf", "b.DOCX", "c.md", "d.csv", "e.pptx", "f.html", "g.png", "h.JPG", "i.tiff"].every(isDocumentFile)).toBe(true);
    expect(["a.exe", "b.gif", "c.zip", "d.ts", "e.svg"].some(isDocumentFile)).toBe(false);
  });
});
