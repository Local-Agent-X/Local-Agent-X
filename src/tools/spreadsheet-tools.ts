import type * as ExcelJSTypes from "exceljs";
import ExcelJSDefault from "exceljs";
// Handle CJS/ESM interop — runtime uses resolved default, types use namespace
const ExcelJS = (ExcelJSDefault as unknown as { default: typeof ExcelJSDefault }).default ?? ExcelJSDefault;
type Workbook = ExcelJSTypes.Workbook;
type Worksheet = ExcelJSTypes.Worksheet;
type Cell = ExcelJSTypes.Cell;
type CellValue = ExcelJSTypes.CellValue;
type CellFormulaValue = ExcelJSTypes.CellFormulaValue;
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ToolDefinition, ToolResult } from "../types.js";
import { acquireImages, IMAGES_PARAM_SCHEMA, type ImageSpec } from "./shared/image-acquire.js";
import { verifyWriteLanded } from "./verify.js";
// Resolve caller paths the SAME way SecurityLayer's file-access gate does
// (project-root anchored, no ~ expansion) so the gated path == the opened path.
import { resolveAgentPath as resolvePath } from "../workspace/paths.js";

// ── Helpers ──

function ok(content: string, metadata?: Record<string, unknown>): ToolResult {
  return { content, ...(metadata && { metadata }) };
}
function fail(msg: string): ToolResult {
  return { content: msg, isError: true };
}

async function openWorkbook(filePath: string): Promise<Workbook> {
  const wb = new ExcelJS.Workbook();
  if (filePath.endsWith(".csv")) {
    await wb.csv.readFile(filePath);
  } else {
    await wb.xlsx.readFile(filePath);
  }
  return wb;
}

function getSheet(wb: Workbook, name?: string): Worksheet {
  const ws = name ? wb.getWorksheet(name) : wb.worksheets[0];
  if (!ws) throw new Error(name ? `Sheet "${name}" not found` : "Workbook has no sheets");
  return ws;
}

function colIndex(letter: string): number {
  let n = 0;
  for (const ch of letter.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n;
}

function parseRange(range: string): { r1: number; c1: number; r2: number; c2: number } {
  const m = range.match(/^([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)$/);
  if (!m) throw new Error(`Invalid range "${range}"`);
  return { c1: colIndex(m[1]), r1: Number(m[2]), c2: colIndex(m[3]), r2: Number(m[4]) };
}

function rowsToTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
  const hdr = "| " + headers.map((h, i) => pad(h, widths[i])).join(" | ") + " |";
  const sep = "| " + widths.map((w) => "-".repeat(w)).join(" | ") + " |";
  const body = rows.map((r) => "| " + headers.map((_, i) => pad(r[i] ?? "", widths[i])).join(" | ") + " |");
  return [hdr, sep, ...body].join("\n");
}

function cellText(cell: Cell): string {
  const v = cell.value;
  if (v == null) return "";
  if (typeof v === "object" && "result" in v) return String((v as { result: unknown }).result ?? "");
  return String(v);
}

// ── Tools ──

const spreadsheetRead: ToolDefinition = {
  name: "spreadsheet_read",
  description: "Read data from an Excel (.xlsx) or CSV file and return a markdown table.",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path to the file" },
      sheet: { type: "string", description: "Sheet name (default: first sheet)" },
      range: { type: "string", description: 'Cell range e.g. "A1:D10"' },
    },
    required: ["file_path"],
  },
  async execute(args) {
    try {
      const wb = await openWorkbook(resolvePath(args.file_path as string));
      const ws = getSheet(wb, args.sheet as string | undefined);
      let headers: string[] = [];
      const rows: string[][] = [];

      if (args.range) {
        const { r1, c1, r2, c2 } = parseRange(args.range as string);
        const hdrRow = ws.getRow(r1);
        for (let c = c1; c <= c2; c++) headers.push(cellText(hdrRow.getCell(c)));
        for (let r = r1 + 1; r <= r2; r++) {
          const row = ws.getRow(r);
          rows.push(Array.from({ length: c2 - c1 + 1 }, (_, i) => cellText(row.getCell(c1 + i))));
        }
      } else {
        ws.eachRow((row, rowNum) => {
          const vals = row.values as CellValue[];
          const texts = vals.slice(1).map((v) => (v == null ? "" : String(v)));
          if (rowNum === 1) headers = texts;
          else rows.push(texts);
        });
      }
      if (!headers.length) return ok("(empty sheet)");
      return ok(rowsToTable(headers, rows), { rows: rows.length, columns: headers.length });
    } catch (e: unknown) {
      return fail(String((e as Error).message ?? e));
    }
  },
};

const spreadsheetWrite: ToolDefinition = {
  name: "spreadsheet_write",
  description:
    "Create or overwrite an Excel sheet with structured data. " +
    "Pass data as a JSON string containing an array of objects (one object per row). " +
    "Keys become column headers. " +
    'Example: data=\'[{"Product":"Widget","Price":9.99,"Qty":100},{"Product":"Gadget","Price":24.99,"Qty":50}]\'',
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path to the .xlsx file to create or update" },
      data: { type: "string", description: 'JSON array of row objects. Example: \'[{"Name":"Alice","Score":95},{"Name":"Bob","Score":87}]\'' },
      sheet: { type: "string", description: 'Sheet name (default: "Sheet1")' },
      headers: { type: "array", items: { type: "string" }, description: "Column headers (auto-derived from data keys if omitted)" },
      images: IMAGES_PARAM_SCHEMA,
    },
    required: ["file_path", "data"],
  },
  async execute(args) {
    try {
      const filePath = resolvePath(args.file_path as string);
      const sheetName = (args.sheet as string) || "Sheet1";
      const parsed: Record<string, unknown>[] = JSON.parse(args.data as string);
      if (!Array.isArray(parsed)) return fail("data must be a JSON array");
      const acquired = await acquireImages((args.images as ImageSpec[] | undefined) ?? []);

      const wb = new ExcelJS.Workbook();
      try { await wb.xlsx.readFile(filePath); } catch { /* new file */ }
      const existing = wb.getWorksheet(sheetName);
      if (existing) wb.removeWorksheet(existing.id);
      const ws = wb.addWorksheet(sheetName);

      const hdrs = (args.headers as string[] | undefined) ?? Object.keys(parsed[0] ?? {});
      ws.addRow(hdrs);
      for (const obj of parsed) ws.addRow(hdrs.map((h) => obj[h] ?? ""));

      // Place each image to the right of the data, stacked vertically.
      // exceljs accepts png/jpeg/gif only — gif/webp/svg fall through.
      const startCol = hdrs.length + 1;
      let row = 0;
      for (const img of acquired) {
        const ext: "png" | "jpeg" | "gif" | null =
          img.mimeType === "image/png" ? "png" :
          img.mimeType === "image/jpeg" ? "jpeg" :
          img.mimeType === "image/gif" ? "gif" :
          null;
        if (!ext) continue;
        // exceljs's Image.buffer references an older Buffer interface; the
        // runtime is the same Node Buffer, so cast through unknown.
        const imageId = wb.addImage({ buffer: img.buffer as unknown as ExcelJSTypes.Image["buffer"], extension: ext });
        ws.addImage(imageId, {
          tl: { col: startCol, row },
          ext: { width: Math.min(img.width || 400, 600), height: Math.min(img.height || 300, 400) },
        });
        row += 20;
      }

      mkdirSync(dirname(filePath), { recursive: true });
      await wb.xlsx.writeFile(filePath);
      const verified = verifyWriteLanded(filePath, { minBytes: 500 });
      if (!verified.ok) return fail(`Failed to write spreadsheet: ${verified.reason}`);
      const imgSuffix = acquired.length ? ` and ${acquired.length} image(s)` : "";
      return ok(`Wrote ${parsed.length} rows${imgSuffix} to "${sheetName}" in ${filePath}`);
    } catch (e: unknown) {
      return fail(String((e as Error).message ?? e));
    }
  },
};

const spreadsheetEdit: ToolDefinition = {
  name: "spreadsheet_edit",
  description: "Edit a single cell in a spreadsheet.",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path to the .xlsx file" },
      sheet: { type: "string", description: "Sheet name (default: first sheet)" },
      cell: { type: "string", description: 'Cell reference e.g. "B5"' },
      value: { type: "string", description: "Value to set" },
      formula: { type: "boolean", description: "Treat value as an Excel formula" },
    },
    required: ["file_path", "cell", "value"],
  },
  async execute(args) {
    try {
      const filePath = resolvePath(args.file_path as string);
      const wb = await openWorkbook(filePath);
      const ws = getSheet(wb, args.sheet as string | undefined);
      const cell = ws.getCell(args.cell as string);
      if (args.formula) {
        cell.value = { formula: args.value as string } as CellFormulaValue;
      } else {
        const num = Number(args.value);
        cell.value = isNaN(num) || (args.value as string).trim() === "" ? (args.value as string) : num;
      }
      await wb.xlsx.writeFile(filePath);
      return ok(`Set ${args.cell} = ${args.value}${args.formula ? " (formula)" : ""}`);
    } catch (e: unknown) {
      return fail(String((e as Error).message ?? e));
    }
  },
};

const spreadsheetQuery: ToolDefinition = {
  name: "spreadsheet_query",
  description: "Filter rows by a column condition and return matching rows.",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path to the file" },
      sheet: { type: "string", description: "Sheet name (default: first sheet)" },
      column: { type: "string", description: "Column header to filter on" },
      operator: { type: "string", enum: ["equals", "contains", "gt", "lt"], description: "Comparison operator" },
      value: { type: "string", description: "Value to compare against" },
    },
    required: ["file_path", "column", "operator", "value"],
  },
  async execute(args) {
    try {
      const wb = await openWorkbook(resolvePath(args.file_path as string));
      const ws = getSheet(wb, args.sheet as string | undefined);
      const headers: string[] = [];
      const allRows: string[][] = [];

      ws.eachRow((row, rowNum) => {
        const vals = (row.values as CellValue[]).slice(1).map((v) => (v == null ? "" : String(v)));
        if (rowNum === 1) headers.push(...vals);
        else allRows.push(vals);
      });

      const ci = headers.indexOf(args.column as string);
      if (ci === -1) return fail(`Column "${args.column}" not found. Available: ${headers.join(", ")}`);

      const target = args.value as string;
      const op = args.operator as string;
      const matched = allRows.filter((r) => {
        const cv = r[ci] ?? "";
        switch (op) {
          case "equals":   return cv === target;
          case "contains": return cv.toLowerCase().includes(target.toLowerCase());
          case "gt":       return Number(cv) > Number(target);
          case "lt":       return Number(cv) < Number(target);
          default:         return false;
        }
      });

      if (!matched.length) return ok("No matching rows found.");
      return ok(rowsToTable(headers, matched), { matchedRows: matched.length });
    } catch (e: unknown) {
      return fail(String((e as Error).message ?? e));
    }
  },
};

export const spreadsheetTools: ToolDefinition[] = [
  spreadsheetRead,
  spreadsheetWrite,
  spreadsheetEdit,
  spreadsheetQuery,
];

export function createSpreadsheetTools(..._args: unknown[]): ToolDefinition[] {
  return spreadsheetTools;
}
