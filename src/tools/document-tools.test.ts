// `document edit` and `document template` change the text INSIDE the .docx
// (shared/docx-edit.ts) instead of extracting it and rebuilding a fresh file:
// the template's header, table and run formatting survive, and a placeholder
// Word split across runs is still filled. `document read` returns the file's
// text as external content, byte-for-byte the wrapper over the mammoth text.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as docx from "docx";
import JSZip from "jszip";
import mammoth from "mammoth";
import { documentTools } from "./document-tools.js";
import { wrapExternalContent } from "../sanitize.js";

const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, Header } = docx;
const tool = documentTools[0];
const dir = mkdtempSync(join(tmpdir(), "document-tool-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const maskId = (text: string): string => text.replace(/ id="[0-9a-f]+"/g, ' id="X"');
const text = async (fp: string): Promise<string> => (await mammoth.extractRawText({ buffer: readFileSync(fp) })).value;
const part = async (fp: string, name: string): Promise<string> => (await JSZip.loadAsync(readFileSync(fp))).file(name)!.async("string");

let template = "";

beforeAll(async () => {
  // A header with a placeholder, a paragraph whose placeholder is split across
  // three runs (one bold), a bold word in its own run, and a table.
  const doc = new Document({
    sections: [{
      headers: { default: new Header({ children: [new Paragraph("Invoice from {{company}}")] }) },
      children: [
        new Paragraph({ children: [
          new TextRun("Dear "), new TextRun({ text: "{{na", bold: true }), new TextRun("me}}"), new TextRun(", "),
          new TextRun({ text: "hello", bold: true }), new TextRun(" there"),
        ] }),
        new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph("{{invoice_id}}")] })] })] }),
      ],
    }],
  });
  template = join(dir, "template.docx");
  writeFileSync(template, await Packer.toBuffer(doc));
});

describe("document template — fills in place", () => {
  it("fills a placeholder split across runs, one in a table and one in the header, keeping both", async () => {
    const out = join(dir, "filled.docx");
    const r = await tool.execute({
      action: "template", template_path: template, output_path: out,
      variables: JSON.stringify({ name: "Alice", invoice_id: "INV-001", company: "Acme & Co" }),
    });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("Replaced 3 placeholder(s)");
    expect(await text(out)).toContain("Dear Alice, hello there");
    expect(await text(out)).toContain("INV-001");
    expect(await part(out, "word/document.xml")).toContain("<w:tbl>");
    expect(await part(out, "word/header1.xml")).toContain("Invoice from Acme &amp; Co");
    // The template itself is untouched.
    expect(await text(template)).toContain("{{na");
  });

  it("refuses images rather than silently dropping them", async () => {
    const r = await tool.execute({
      action: "template", template_path: template, output_path: join(dir, "img.docx"),
      variables: "{}", images: [{ source: "https://example.com/x.png" }],
    });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/cannot add images/);
  });
});

describe("document edit — replaces in place", () => {
  it("keeps the run's own formatting, the table and the header on a within-run match", async () => {
    const fp = join(dir, "edit.docx");
    writeFileSync(fp, readFileSync(template));
    const boldRunsBefore = (await part(fp, "word/document.xml")).match(/<w:b\/>/g)?.length;
    const r = await tool.execute({ action: "edit", file_path: fp, find: "hello", replace: "goodbye" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("Replaced 1 occurrence(s)");
    expect(r.content).not.toMatch(/merged/);
    const xml = await part(fp, "word/document.xml");
    expect(xml).toContain("<w:tbl>");
    expect(xml.match(/<w:b\/>/g)?.length).toBe(boldRunsBefore);
    expect(await text(fp)).toContain("goodbye there");
    expect(await part(fp, "word/header1.xml")).toContain("{{company}}");
  });

  it("says when a cross-run match merged a paragraph, and reports no occurrences without writing", async () => {
    const fp = join(dir, "edit2.docx");
    writeFileSync(fp, readFileSync(template));
    const merged = await tool.execute({ action: "edit", file_path: fp, find: "Dear {{name}}", replace: "Hi Bob" });
    expect(merged.isError).toBeFalsy();
    expect(merged.content).toMatch(/merged that paragraph's runs/);
    expect(await text(fp)).toContain("Hi Bob, hello there");

    const before = readFileSync(fp);
    const none = await tool.execute({ action: "edit", file_path: fp, find: "absent", replace: "x" });
    expect(none.isError).toBeFalsy();
    expect(none.content).toMatch(/No occurrences/);
    expect(readFileSync(fp).equals(before)).toBe(true);
  });
});

describe("document read — the file's text is external content", () => {
  it("is byte-for-byte the wrapper over the extracted text", async () => {
    const r = await tool.execute({ action: "read", file_path: template });
    expect(r.isError).toBeFalsy();
    const raw = (await text(template)).trim();
    expect(maskId(r.content)).toBe(maskId(wrapExternalContent(raw, "document.read", { file: template })));
    expect(r.metadata).toMatchObject({ characters: raw.length });
  });
});
