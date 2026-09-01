import type * as ExcelJSTypes from "exceljs";
import ExcelJSDefault from "exceljs";
// Handle CJS/ESM interop — runtime uses resolved default, types use namespace
const ExcelJS = (ExcelJSDefault as unknown as { default: typeof ExcelJSDefault }).default ?? ExcelJSDefault;
type Workbook = ExcelJSTypes.Workbook;
type Worksheet = ExcelJSTypes.Worksheet;
type CellValue = ExcelJSTypes.CellValue;
type CellFormulaValue = ExcelJSTypes.CellFormulaValue;
import { closeSync, fstatSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import type { ToolDefinition, ToolResult } from "../types.js";
import { acquireImages, IMAGES_PARAM_SCHEMA, type ImageSpec } from "./shared/image-acquire.js";
import { verifyWriteLanded } from "./verify.js";
// Resolve caller paths the SAME way SecurityLayer's file-access gate does
// (project-root anchored, no ~ expansion) so the gated path == the opened path.
import { resolveAgentPath as resolvePath } from "../workspace/paths.js";
import { openValidatedRead } from "../security/layer/index.js";
import { resolveOfficeTheme, argb, brandAuthor, brandFooter, type OfficeTheme, THEME_PARAM_SCHEMA } from "./shared/office-theme.js";
import { cleanText } from "./shared/office-md.js";
import { collapseFamily } from "./shared/collapse-family.js";
// Pure formatting + the input caps (workbook bytes, rows, cells, padding). See
// the module header there for what each cap bounds — and what it does not.
import {
  MAX_ROWS_UNRANGED, assertWorkbookSize, cellText, clampRange, matchCapNote, parseRange, rowCapNote, rowsToTable, valueText,
} from "./spreadsheet-format.js";

// ── Helpers ──

const CURRENCY_HEADER = /price|cost|revenue|total|amount|sales|spend|budget|\$|usd/i;

/** Apply the house style to a freshly-written sheet: bold accent header row,
 *  banded data rows, thin borders, frozen header, autofit widths, and a
 *  thousands/currency number format on numeric columns. */
function styleSheet(
  ws: Worksheet,
  hdrs: string[],
  rows: Record<string, unknown>[],
  theme: OfficeTheme,
): void {
  const border = { style: "thin" as const, color: { argb: argb(theme.colors.border) } };
  const allBorders = { top: border, left: border, bottom: border, right: border };

  const header = ws.getRow(1);
  header.height = 20;
  header.eachCell((cell) => {
    cell.font = { name: theme.fonts.heading, bold: true, color: { argb: argb(theme.colors.accentText) }, size: 11 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(theme.colors.accent) } };
    cell.alignment = { vertical: "middle" };
    cell.border = allBorders;
  });

  for (let r = 2; r <= rows.length + 1; r++) {
    const row = ws.getRow(r);
    const banded = r % 2 === 1; // every other data row
    row.eachCell((cell) => {
      cell.font = { name: theme.fonts.body, size: 11, color: { argb: argb(theme.colors.body) } };
      cell.border = allBorders;
      if (banded) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(theme.colors.band) } };
    });
  }

  hdrs.forEach((h, i) => {
    const col = ws.getColumn(i + 1);
    const maxLen = Math.max(h.length, ...rows.map((o) => String(o[h] ?? "").length));
    col.width = Math.min(Math.max(maxLen + 2, 10), 60);
    // Numeric/currency formatting: a column is numeric when every non-empty
    // value parses as a number. Currency-named headers get a $ format.
    const vals = rows.map((o) => o[h]).filter((v) => v !== "" && v != null);
    const numeric = vals.length > 0 && vals.every((v) => typeof v === "number" || (!isNaN(Number(v)) && String(v).trim() !== ""));
    if (numeric) col.numFmt = CURRENCY_HEADER.test(h) ? '$#,##0.00' : '#,##0.##';
  });

  ws.views = [{ state: "frozen", ySplit: 1 }];
}

function ok(content: string, metadata?: Record<string, unknown>): ToolResult {
  return { content, ...(metadata && { metadata }) };
}
function fail(msg: string): ToolResult {
  return { content: msg, isError: true };
}

async function openWorkbook(filePath: string): Promise<Workbook> {
  // Read the VALIDATED canonical inode (realpath + O_NOFOLLOW leaf) and load
  // exceljs from those bytes, so a symlink swapped in after the gate (R4-19) is
  // rejected rather than parsed. exceljs reads the buffer/stream, never reopens
  // the path itself, so there is no second lexical open to race. The size cap
  // is fstat'd on that SAME fd, so it binds to the inode actually read.
  const { fd } = openValidatedRead(filePath);
  let buf: Buffer;
  try {
    assertWorkbookSize(fstatSync(fd).size);
    buf = readFileSync(fd);
  } finally {
    closeSync(fd);
  }
  const wb = new ExcelJS.Workbook();
  if (filePath.endsWith(".csv")) {
    await wb.csv.read(Readable.from(buf));
  } else {
    // exceljs bundles an older Buffer interface; the runtime is the same Node
    // Buffer, so cast through unknown (same interop as addImage below).
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
  }
  return wb;
}

function getSheet(wb: Workbook, name?: string): Worksheet {
  const ws = name ? wb.getWorksheet(name) : wb.worksheets[0];
  if (!ws) throw new Error(name ? `Sheet "${name}" not found` : "Workbook has no sheets");
  return ws;
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
      let note = "";
      let totalRows = 0;

      if (args.range) {
        const clamped = clampRange(parseRange(args.range as string));
        const { r1, c1, r2, c2 } = clamped.range;
        note = clamped.note;
        const hdrRow = ws.getRow(r1);
        for (let c = c1; c <= c2; c++) headers.push(cellText(hdrRow.getCell(c)));
        for (let r = r1 + 1; r <= r2; r++) {
          const row = ws.getRow(r);
          rows.push(Array.from({ length: c2 - c1 + 1 }, (_, i) => cellText(row.getCell(c1 + i))));
        }
      } else {
        // Rows past the cap are counted, never materialized: the object model
        // is already resident; the text copies + table string are what this bounds.
        ws.eachRow((row, rowNum) => {
          if (rowNum === 1) { headers = (row.values as CellValue[]).slice(1).map(valueText); return; }
          totalRows++;
          if (rows.length < MAX_ROWS_UNRANGED) rows.push((row.values as CellValue[]).slice(1).map(valueText));
        });
        note = rowCapNote(rows.length, totalRows);
      }
      if (!headers.length) return ok("(empty sheet)");
      const meta: Record<string, unknown> = { rows: rows.length, columns: headers.length };
      if (note) meta.truncated = true;
      if (totalRows > rows.length) meta.totalRows = totalRows;
      return ok(rowsToTable(headers, rows) + note, meta);
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
      theme: THEME_PARAM_SCHEMA,
    },
    required: ["file_path", "data"],
  },
  async execute(args) {
    try {
      const filePath = resolvePath(args.file_path as string);
      const sheetName = (args.sheet as string) || "Sheet1";
      const parsed: Record<string, unknown>[] = JSON.parse(args.data as string);
      if (!Array.isArray(parsed)) return fail("data must be a JSON array");
      const { images: acquired, notes: imageNotes } = await acquireImages((args.images as ImageSpec[] | undefined) ?? []);

      const theme = resolveOfficeTheme(args.theme);
      const wb = new ExcelJS.Workbook();
      // Merging into an existing workbook loads it whole — same cap as read,
      // checked OUTSIDE the new-file catch so an oversized target fails loudly
      // instead of being silently replaced by a one-sheet workbook.
      const onDisk = statSync(filePath, { throwIfNoEntry: false });
      if (onDisk) assertWorkbookSize(onDisk.size);
      try { await wb.xlsx.readFile(filePath); } catch { /* new file */ }
      // File metadata: the USER's brand (or empty) — never the app name.
      wb.creator = brandAuthor(theme);
      wb.lastModifiedBy = brandAuthor(theme);
      const existing = wb.getWorksheet(sheetName);
      if (existing) wb.removeWorksheet(existing.id);
      const ws = wb.addWorksheet(sheetName);
      const footerCompany = brandFooter(theme);
      ws.headerFooter = { oddFooter: `${footerCompany ? `&L${footerCompany}` : ""}&RPage &P of &N` };

      const hdrs = (args.headers as string[] | undefined) ?? Object.keys(parsed[0] ?? {});
      ws.addRow(hdrs.map((h) => cleanText(h)));
      // Coerce clean numeric strings to numbers so number formats render and
      // Excel sorts/sums them — but only when the value round-trips exactly, so
      // "02134" (zip) or "1e3" stay text rather than mutating. Strings get
      // sanitized (no HTML/entities leak into cells).
      const coerce = (v: unknown): unknown => {
        if (typeof v === "string") {
          if (v.trim() !== "" && String(Number(v)) === v.trim()) return Number(v);
          return cleanText(v);
        }
        return v ?? "";
      };
      for (const obj of parsed) ws.addRow(hdrs.map((h) => coerce(obj[h])));
      styleSheet(ws, hdrs, parsed, theme);

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
      const notes = imageNotes.length ? `\nImage notes:\n${imageNotes.join("\n")}` : "";
      return ok(`Wrote ${parsed.length} rows${imgSuffix} to "${sheetName}" in ${filePath}${notes}`);
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
      const matched: string[][] = [];
      let ci = -1;
      let total = 0;
      const target = args.value as string;
      const op = args.operator as string;
      const test = (cv: string): boolean => {
        switch (op) {
          case "equals":   return cv === target;
          case "contains": return cv.toLowerCase().includes(target.toLowerCase());
          case "gt":       return Number(cv) > Number(target);
          case "lt":       return Number(cv) < Number(target);
          default:         return false;
        }
      };

      // Stream the scan: EVERY row is tested (a match past the cap is still
      // counted, so the answer stays correct) but only the first
      // MAX_ROWS_UNRANGED matches are kept — the sheet is never copied whole.
      ws.eachRow((row, rowNum) => {
        const vals = (row.values as CellValue[]).slice(1).map(valueText);
        if (rowNum === 1) { headers.push(...vals); ci = headers.indexOf(args.column as string); return; }
        if (ci === -1 || !test(vals[ci] ?? "")) return;
        total++;
        if (matched.length < MAX_ROWS_UNRANGED) matched.push(vals);
      });

      if (ci === -1) return fail(`Column "${args.column}" not found. Available: ${headers.join(", ")}`);
      if (!matched.length) return ok("No matching rows found.");
      const note = matchCapNote(matched.length, total);
      const meta: Record<string, unknown> = { matchedRows: total };
      if (note) { meta.shownRows = matched.length; meta.truncated = true; }
      return ok(rowsToTable(headers, matched) + note, meta);
    } catch (e: unknown) {
      return fail(String((e as Error).message ?? e));
    }
  },
};

// One collapsed tool (action param) — the four defs above stay as the
// per-action implementations. pathArgs gating for file_path is action-
// conditional (forActions in tool-policies.apps.ts); keep both in sync
// when adding an action.
export const spreadsheetTools: ToolDefinition[] = [
  collapseFamily({
    name: "spreadsheet",
    intro:
      "Read, create, edit, and query Excel (.xlsx) / CSV spreadsheets. " +
      "Use for spreadsheet files — never write Python pandas scripts for this. " +
      "For advanced custom workbooks beyond these actions, a Node build script may use exceljs directly — it's bundled, so `require('exceljs')` by bare name (never an absolute cwd/node_modules path).",
    actions: {
      read: spreadsheetRead,
      write: spreadsheetWrite,
      edit: spreadsheetEdit,
      query: spreadsheetQuery,
    },
    fullActionDocs: true,
    properties: {
      file_path: { type: "string", description: "Path to the spreadsheet file" },
      sheet: { type: "string", description: "Sheet name (default: first sheet / Sheet1)" },
      range: { type: "string", description: '(read) Cell range e.g. "A1:D10"' },
      data: { type: "string", description: "(write) JSON array of row objects — keys become column headers" },
      headers: { type: "array", items: { type: "string" }, description: "(write) Column headers (auto-derived from data keys if omitted)" },
      images: IMAGES_PARAM_SCHEMA,
      theme: THEME_PARAM_SCHEMA,
      cell: { type: "string", description: '(edit) Cell reference e.g. "B5"' },
      value: { type: "string", description: "(edit) Value to set | (query) value to compare against" },
      formula: { type: "boolean", description: "(edit) Treat value as an Excel formula" },
      column: { type: "string", description: "(query) Column header to filter on" },
      operator: { type: "string", enum: ["equals", "contains", "gt", "lt"], description: "(query) Comparison operator" },
    },
    required: ["file_path"],
  }),
];

export function createSpreadsheetTools(..._args: unknown[]): ToolDefinition[] {
  return spreadsheetTools;
}
