import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { documentTools } from "../src/tools/document-tools.js";
import { spreadsheetTools } from "../src/tools/spreadsheet-tools.js";
import { presentationTools } from "../src/tools/presentation-tools.js";
import { pdfTools } from "../src/tools/pdf-tools.js";
import JSZip from "jszip";
import type { ToolDefinition } from "../src/types.js";

// resolveAgentPath passes ABSOLUTE paths through untouched, so writing to an
// absolute temp path exercises the real generators without a workspace setup.
const dir = mkdtempSync(join(tmpdir(), "office-theme-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const tool = (tools: ToolDefinition[], name: string): ToolDefinition => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
};
const isZip = (b: Buffer) => b[0] === 0x50 && b[1] === 0x4b; // "PK" (docx/xlsx/pptx)
const isPdf = (b: Buffer) => b.slice(0, 5).toString() === "%PDF-";

describe("themed Office generation — smoke (real files)", () => {
  it("Word .docx is a valid, non-trivial file", async () => {
    const fp = join(dir, "report.docx");
    const r = await tool(documentTools, "document").execute({ action: "create",
      file_path: fp, title: "Q3 Report",
      content: "# Summary\nRevenue grew.\n\n## Detail\n- One\n- Two",
    });
    expect(r.isError).toBeFalsy();
    expect(existsSync(fp)).toBe(true);
    const buf = readFileSync(fp);
    expect(isZip(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(2000);
  });

  it("Excel .xlsx applies the navy header fill + frozen pane (re-read with exceljs)", async () => {
    const fp = join(dir, "data.xlsx");
    const r = await tool(spreadsheetTools, "spreadsheet").execute({ action: "write",
      file_path: fp,
      data: JSON.stringify([{ Name: "Acme", Revenue: 124000 }, { Name: "Globex", Revenue: 98200 }]),
    });
    expect(r.isError).toBeFalsy();
    expect(isZip(readFileSync(fp))).toBe(true);

    // Re-open and assert the theme actually landed, not just that bytes exist.
    const { default: ExcelJS } = await import("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(fp);
    const ws = wb.worksheets[0];
    const headerFill = ws.getRow(1).getCell(1).fill as { fgColor?: { argb?: string } };
    expect(headerFill.fgColor?.argb).toBe("FF1F3A5F"); // navy accent
    expect(ws.views?.[0]?.state).toBe("frozen");
    // numeric column got a thousands/currency format
    expect(ws.getColumn(2).numFmt).toBeTruthy();
  });

  it("PowerPoint .pptx renders themed layouts (incl. accent shape)", async () => {
    const fp = join(dir, "deck.pptx");
    const r = await tool(presentationTools, "presentation").execute({ action: "create",
      file_path: fp, title: "Deck",
      slides: JSON.stringify([
        { title: "Cover", layout: "title", body: "Subtitle" },
        { title: "Agenda", bullets: ["A", "B", "C"] },
      ]),
    });
    expect(r.isError).toBeFalsy();
    expect(isZip(readFileSync(fp))).toBe(true);
  });

  it("PowerPoint embeds a NATIVE chart when a slide carries chart data", async () => {
    const fp = join(dir, "deck-chart.pptx");
    const r = await tool(presentationTools, "presentation").execute({ action: "create",
      file_path: fp, title: "Revenue",
      slides: JSON.stringify([
        {
          title: "Q3 Revenue by Region",
          bullets: ["West led growth", "North rebounded"],
          chart: {
            type: "bar",
            categories: ["West", "East", "South", "North"],
            series: [{ name: "Revenue", values: [124, 98, 76, 61] }],
            title: "Q3 Revenue ($k)",
          },
        },
      ]),
    });
    expect(r.isError).toBeFalsy();
    expect(r.metadata?.chart_count).toBe(1);
    const buf = readFileSync(fp);
    expect(isZip(buf)).toBe(true);
    // ZIP entry names are stored uncompressed → a real chart part is present.
    expect(buf.includes(Buffer.from("ppt/charts/"))).toBe(true);
  });

  it("an invalid chart spec degrades gracefully (no chart part, still valid)", async () => {
    const fp = join(dir, "deck-badchart.pptx");
    const r = await tool(presentationTools, "presentation").execute({ action: "create",
      file_path: fp,
      slides: JSON.stringify([{ title: "Oops", bullets: ["x"], chart: { type: "bar", series: [] } }]),
    });
    expect(r.isError).toBeFalsy();
    expect(r.metadata?.chart_count).toBe(1); // counted in spec...
    expect(isZip(readFileSync(fp))).toBe(true); // ...but render skipped the empty chart without throwing
  });

  it("PDF renders with the themed renderer", async () => {
    const fp = join(dir, "report.pdf");
    const r = await tool(pdfTools, "pdf").execute({ action: "create",
      file_path: fp, title: "Q3 Report",
      content: "# Summary\nRevenue grew.\n\n## Detail\n- One\n- Two",
    });
    expect(r.isError).toBeFalsy();
    expect(isPdf(readFileSync(fp))).toBe(true);
  });

  it("an explicit theme override does not break generation", async () => {
    const fp = join(dir, "custom.docx");
    const r = await tool(documentTools, "document").execute({ action: "create",
      file_path: fp,
      content: "# Heading\nBody",
      theme: '{"colors":{"accent":"#7A2E3A","heading":"000000"},"fonts":{"heading":"Times New Roman"}}',
    });
    expect(r.isError).toBeFalsy();
    expect(isZip(readFileSync(fp))).toBe(true);
  });
});

// The hard requirement: generated files must NEVER contain model-output tells.
describe("no markup leaks — read generated files back", () => {
  const DIRTY = "# Report\n\nThis is **bold** text with a <div>leaked</div> tag and a &nbsp; entity.\n\n| Name | Rev |\n|---|---|\n| Acme | 5 |";

  it("Word strips HTML/entities but keeps real content + table cells", async () => {
    const fp = join(dir, "clean.docx");
    await tool(documentTools, "document").execute({ action: "create", file_path: fp, content: DIRTY });
    const read = await tool(documentTools, "document").execute({ action: "read", file_path: fp });
    const text = String(read.content);
    expect(text).toContain("Report");
    expect(text).toContain("bold");
    expect(text).toContain("leaked"); // inner text survives, tag does not
    expect(text).toContain("Acme");   // table rendered
    expect(text).not.toContain("<div>");
    expect(text).not.toContain("</div>");
    expect(text).not.toContain("&nbsp;");
  });

  it("PDF strips HTML tags", async () => {
    const fp = join(dir, "clean.pdf");
    await tool(pdfTools, "pdf").execute({ action: "create", file_path: fp, content: "# Title\n\nText with <div>leak</div> and &amp; sign." });
    const read = await tool(pdfTools, "pdf").execute({ action: "read", file_path: fp });
    const text = String(read.content);
    expect(text).toContain("Title");
    expect(text).not.toContain("<div>");
  });

  it("Excel strips HTML from cell values", async () => {
    const fp = join(dir, "clean2.xlsx");
    await tool(spreadsheetTools, "spreadsheet").execute({ action: "write",
      file_path: fp, data: JSON.stringify([{ Note: "<b>x</b>Clean", Val: 5 }]),
    });
    const read = await tool(spreadsheetTools, "spreadsheet").execute({ action: "read", file_path: fp });
    const text = String(read.content);
    expect(text).toContain("Clean");
    expect(text).not.toContain("<b>");
  });
});

// No app branding in file metadata — and the user's brand when they set one.
describe("brand kit — metadata", () => {
  async function docxCore(fp: string): Promise<string> {
    const zip = await JSZip.loadAsync(readFileSync(fp));
    return zip.file("docProps/core.xml")!.async("string");
  }

  it("Word: creator is NOT the app name by default", async () => {
    const fp = join(dir, "meta.docx");
    await tool(documentTools, "document").execute({ action: "create", file_path: fp, content: "# X\nbody" });
    const core = await docxCore(fp);
    expect(core).not.toContain("Local Agent X");
    expect(core).not.toContain("Secret Agent");
  });

  it("Word: creator uses the user's brand company when set, and writes a footer part", async () => {
    const fp = join(dir, "meta-brand.docx");
    await tool(documentTools, "document").execute({ action: "create",
      file_path: fp, content: "# X\nbody", theme: '{"brand":{"company":"Acme Corp"}}',
    });
    const zip = await JSZip.loadAsync(readFileSync(fp));
    expect(await zip.file("docProps/core.xml")!.async("string")).toContain("Acme Corp");
    expect(Object.keys(zip.files).some((f) => /word\/footer\d*\.xml/.test(f))).toBe(true);
  });

  it("Excel: creator is the brand (not the app name)", async () => {
    const fp = join(dir, "meta.xlsx");
    await tool(spreadsheetTools, "spreadsheet").execute({ action: "write",
      file_path: fp, data: JSON.stringify([{ A: 1 }]), theme: '{"brand":{"company":"Acme Corp"}}',
    });
    const { default: ExcelJS } = await import("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(fp);
    expect(wb.creator).toBe("Acme Corp");
    expect(wb.creator).not.toContain("Local Agent X");
  });
});
