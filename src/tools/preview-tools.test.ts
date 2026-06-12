import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pdfTools } from "./pdf-tools.js";
import { documentTools } from "./document-tools.js";
import { previewTools } from "./preview-tools.js";
import type { ToolDefinition } from "../types.js";

const dir = mkdtempSync(join(tmpdir(), "preview-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const find = (a: ToolDefinition[], n: string) => a.find((t) => t.name === n)!;
const preview = previewTools[0];
const isPng = (b: Buffer) => b[0] === 0x89 && b.slice(1, 4).toString() === "PNG";

describe("preview_document", () => {
  it("PDF: structural check + a REAL page-1 PNG thumbnail (pdfjs+canvas)", async () => {
    const fp = join(dir, "r.pdf");
    await find(pdfTools, "pdf").execute({ action: "create", file_path: fp, title: "Q3", content: "# Summary\nRevenue grew.\n\n## Detail\n- a\n- b" });
    const r = await preview.execute({ file_path: fp });
    expect(r.isError).toBeFalsy();
    expect(r.metadata?.kind).toBe("pdf");
    expect(r.metadata?.flags).toEqual([]); // clean output, no leaked markup
    expect(String(r.content)).toMatch(/page\(s\)/);
    const thumb = r.metadata?.thumbnail as string | undefined;
    expect(thumb).toBeTruthy();
    expect(existsSync(thumb!)).toBe(true);
    expect(isPng(readFileSync(thumb!))).toBe(true);
  });

  it("DOCX: structural check; thumbnail degrades gracefully without LibreOffice", async () => {
    const fp = join(dir, "r.docx");
    await find(documentTools, "document").execute({ action: "create", file_path: fp, content: "# Report\nBody **bold** text" });
    const r = await preview.execute({ file_path: fp });
    expect(r.isError).toBeFalsy();
    expect(r.metadata?.kind).toBe("docx");
    expect(r.metadata?.flags).toEqual([]);
    expect(String(r.content)).toContain("paragraph");
    // soffice not installed here → no thumbnail, but a clear reason, no crash
    if (!r.metadata?.thumbnail) expect(String(r.content)).toMatch(/LibreOffice/i);
  });

  it("errors on a missing file", async () => {
    const r = await preview.execute({ file_path: join(dir, "nope.pdf") });
    expect(r.isError).toBe(true);
  });
});
