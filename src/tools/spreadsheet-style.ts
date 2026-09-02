/**
 * House styling for freshly-written spreadsheet sheets (spreadsheet-tools.ts
 * write action). Pure formatting over an already-populated worksheet — no
 * I/O, no workbook construction — split out of spreadsheet-tools.ts so the
 * tool module stays under the file-size gate.
 */
import type * as ExcelJSTypes from "exceljs";
type Worksheet = ExcelJSTypes.Worksheet;
import { argb, type OfficeTheme } from "./shared/office-theme.js";

const CURRENCY_HEADER = /price|cost|revenue|total|amount|sales|spend|budget|\$|usd/i;

/** Apply the house style to a freshly-written sheet: bold accent header row,
 *  banded data rows, thin borders, frozen header, autofit widths, and a
 *  thousands/currency number format on numeric columns. */
export function styleSheet(
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
