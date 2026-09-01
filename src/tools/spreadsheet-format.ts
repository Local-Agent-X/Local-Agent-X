/**
 * Pure formatting + bounding helpers for the spreadsheet tool (spreadsheet-tools.ts).
 * No I/O and nothing of the exceljs object model beyond the Cell/CellValue
 * types — every function here is a function of the values it is handed, so it
 * is unit-testable without a workbook.
 *
 * The caps live here so they are one named table. They are INPUT-size caps,
 * not heap bounds: exceljs is fully buffered (the zip bytes, the unzipped XML
 * and one JS object per cell are all live at once) and its object model was
 * measured at 23–107× the file size, so a cap on bytes-in bounds the heap only
 * up to that multiplier. Only a streaming reader could bound cells directly
 * (descoped). What these caps DO close are the tool's own unbounded
 * allocations: ws.getRow()/getCell() CREATE the rows and cells they are asked
 * for, so a ranged read like A1:Z100000 on a 20-row sheet allocated 569 MB
 * before clampRange existed; and an un-ranged read/query copied every row of
 * the sheet to text plus a full-sheet markdown table that the 50KB result
 * budget (tool-execution/audit-tool-call.ts) only trimmed AFTER it was built.
 */
import type * as ExcelJSTypes from "exceljs";
type Cell = ExcelJSTypes.Cell;
type CellValue = ExcelJSTypes.CellValue;

/** Largest workbook the tool will load. Measured exceljs expansion is 23–107×
 *  the file size (107× for repeated short strings: a 7.3 MB file retained
 *  781 MB), so 8 MB keeps the measured worst case under ~1 GB on the 4 GB
 *  heap; 25 MB would have permitted ~3 GB. */
export const MAX_WORKBOOK_BYTES = 8 * 1024 * 1024;
/** Data rows materialized by an un-ranged read, or kept by a query. */
export const MAX_ROWS_UNRANGED = 500;
/** Hard cell ceiling for a ranged read (header row included). */
export const MAX_RANGE_CELLS = 5000;
/** Column width used for PADDING. A longer cell is emitted untruncated but
 *  never forces every other row in its column to pad out to its length. */
export const MAX_COL_WIDTH = 80;

export interface CellRange { r1: number; c1: number; r2: number; c2: number }

export function colIndex(letter: string): number {
  let n = 0;
  for (const ch of letter.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n;
}

export function colLetter(n: number): string {
  let s = "";
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

export function parseRange(range: string): CellRange {
  const m = range.match(/^([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)$/);
  if (!m) throw new Error(`Invalid range "${range}"`);
  return { c1: colIndex(m[1]), r1: Number(m[2]), c2: colIndex(m[3]), r2: Number(m[4]) };
}

export function rangeText(r: CellRange): string {
  return `${colLetter(r.c1)}${r.r1}:${colLetter(r.c2)}${r.r2}`;
}

/**
 * Clamp a requested range to MAX_RANGE_CELLS, rows-first: a range's width is
 * its schema (kept), its height is what allocates (cut) — ws.getRow()/getCell()
 * CREATE the rows and cells they are asked for, so an oversized range
 * materializes an object per cell whether or not the sheet has data there.
 * An inverted range is returned as-is — it reads nothing, exactly as before.
 * Returns the note to append to the table when clamping happened ("" otherwise).
 */
export function clampRange(req: CellRange): { range: CellRange; note: string } {
  const cols = req.c2 - req.c1 + 1;
  const rows = req.r2 - req.r1 + 1;
  if (cols < 1 || rows < 1) return { range: req, note: "" };
  if (cols > MAX_RANGE_CELLS) {
    throw new Error(`Range ${rangeText(req)} spans ${cols} columns; the hard ceiling is ${MAX_RANGE_CELLS} cells — narrow the columns`);
  }
  const maxRows = Math.floor(MAX_RANGE_CELLS / cols);
  if (rows <= maxRows) return { range: req, note: "" };
  const range = { ...req, r2: req.r1 + maxRows - 1 };
  return {
    range,
    note: `\n\n(range ${rangeText(req)} clamped to ${rangeText(range)} — hard ceiling is ${MAX_RANGE_CELLS} cells; read the rest in further ranges)`,
  };
}

/**
 * Space-padded markdown table. Widths are computed with a loop (a spread over
 * every row's length threw RangeError past ~100k rows) and capped at
 * MAX_COL_WIDTH so one long cell cannot multiply padding across the sheet.
 * Output is byte-identical to the old builder whenever no cell exceeds the cap.
 */
export function rowsToTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h) => Math.min(h.length, MAX_COL_WIDTH));
  for (const r of rows) {
    for (let i = 0; i < widths.length; i++) {
      const len = (r[i] ?? "").length;
      if (len > widths[i]) widths[i] = Math.min(len, MAX_COL_WIDTH);
    }
  }
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
  const hdr = "| " + headers.map((h, i) => pad(h, widths[i])).join(" | ") + " |";
  const sep = "| " + widths.map((w) => "-".repeat(w)).join(" | ") + " |";
  const body = rows.map((r) => "| " + headers.map((_, i) => pad(r[i] ?? "", widths[i])).join(" | ") + " |");
  return [hdr, sep, ...body].join("\n");
}

/** Text for a Cell fetched by address (ranged read): formula cells render their result. */
export function cellText(cell: Cell): string {
  const v = cell.value;
  if (v == null) return "";
  if (typeof v === "object" && "result" in v) return String((v as { result: unknown }).result ?? "");
  return String(v);
}

/** Text for a value out of `row.values` (un-ranged read / query). */
export function valueText(v: CellValue): string {
  return v == null ? "" : String(v);
}

// ── Notes appended to a bounded result so the model knows it saw a slice ──

const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);

/** A workbook past the cap is refused BEFORE a byte is read — exceljs would
 *  otherwise hold the zip, the unzipped XML and one object per cell at once. */
export function assertWorkbookSize(bytes: number): void {
  if (bytes <= MAX_WORKBOOK_BYTES) return;
  throw new Error(`Workbook is ${mb(bytes)} MB; the spreadsheet tool loads whole workbooks into memory and caps at ${mb(MAX_WORKBOOK_BYTES)} MB — convert it to CSV or split it into smaller files`);
}

export function rowCapNote(shown: number, total: number): string {
  if (total <= shown) return "";
  return `\n\n(showing first ${shown} of ${total} rows; pass a range to read more)`;
}

export function matchCapNote(shown: number, total: number): string {
  if (total <= shown) return "";
  return `\n\n(showing first ${shown} of ${total} matching rows; narrow the filter to see the rest)`;
}
