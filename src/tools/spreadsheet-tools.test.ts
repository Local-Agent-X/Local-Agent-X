import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJSDefault from "exceljs";
import { spreadsheetTools } from "./spreadsheet-tools.js";
import {
  MAX_COL_WIDTH, MAX_RANGE_CELLS, MAX_ROWS_UNRANGED, MAX_WORKBOOK_BYTES,
  clampRange, parseRange, rowsToTable,
} from "./spreadsheet-format.js";

// Same CJS/ESM interop the tool itself uses.
const ExcelJS = (ExcelJSDefault as unknown as { default: typeof ExcelJSDefault }).default ?? ExcelJSDefault;
const tool = spreadsheetTools[0];
const dir = mkdtempSync(join(tmpdir(), "spreadsheet-tool-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function writeSheet(name: string, rows: unknown[][]): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  for (const r of rows) ws.addRow(r);
  const fp = join(dir, name);
  await wb.xlsx.writeFile(fp);
  return fp;
}

/** A file whose stat size is over the cap without writing the bytes (sparse
 *  on APFS/ext4). Its content is all zeros, so if the tool ever tried to LOAD
 *  it exceljs would fail with a zip error — the exact cap message proves the
 *  refusal happened before any load. */
function sparseFile(name: string, bytes: number): string {
  const fp = join(dir, name);
  writeFileSync(fp, "");
  truncateSync(fp, bytes);
  return fp;
}

const BIG = 1500;
const HUGE_BYTES = 50 * 1024 * 1024; // fixed, well over the cap whatever the cap is
const CAP_MB = (MAX_WORKBOOK_BYTES / (1024 * 1024)).toFixed(1);
const CAP_MSG = `Workbook is 50.0 MB; the spreadsheet tool loads whole workbooks into memory and caps at ${CAP_MB} MB — convert it to CSV or split it into smaller files`;
let small = "";
let big = "";
let huge = "";

beforeAll(async () => {
  small = await writeSheet("small.xlsx", [["Name", "Qty"], ["Widget", 3], ["Gadget", 12]]);
  big = await writeSheet("big.xlsx", [["Id", "Name"], ...Array.from({ length: BIG }, (_, i) => [i + 1, `row-${i + 1}`])]);
  huge = sparseFile("huge.xlsx", HUGE_BYTES);
});

const PINNED_SMALL = [
  "| Name   | Qty |",
  "| ------ | --- |",
  "| Widget | 3   |",
  "| Gadget | 12  |",
].join("\n");

describe("spreadsheet read — small sheets are byte-identical to before", () => {
  it("un-ranged read pins the exact table and metadata", async () => {
    const r = await tool.execute({ action: "read", file_path: small });
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe(PINNED_SMALL);
    expect(r.metadata).toEqual({ rows: 2, columns: 2 });
  });

  it("ranged read within the ceiling is unchanged and carries no note", async () => {
    const r = await tool.execute({ action: "read", file_path: small, range: "A1:B2" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe(["| Name   | Qty |", "| ------ | --- |", "| Widget | 3   |"].join("\n"));
    expect(r.metadata).toEqual({ rows: 1, columns: 2 });
  });
});

describe("spreadsheet read — row cap", () => {
  it(`un-ranged read of ${BIG} rows materializes ${MAX_ROWS_UNRANGED} and says so`, async () => {
    const r = await tool.execute({ action: "read", file_path: big });
    expect(r.isError).toBeFalsy();
    const [table, note] = r.content.split("\n\n");
    const lines = table.split("\n");
    expect(lines).toHaveLength(MAX_ROWS_UNRANGED + 2);
    // Widths are computed over the MATERIALIZED rows only (Id pads to 3, not 4).
    expect(lines[2]).toBe("| 1   | row-1   |");
    expect(lines.at(-1)).toBe(`| ${MAX_ROWS_UNRANGED} | row-${MAX_ROWS_UNRANGED} |`);
    expect(note).toBe(`(showing first ${MAX_ROWS_UNRANGED} of ${BIG} rows; pass a range to read more)`);
    expect(r.metadata).toEqual({ rows: MAX_ROWS_UNRANGED, columns: 2, totalRows: BIG, truncated: true });
  });

  it("ranged read honors the hard cell ceiling and reports the clamp", async () => {
    const r = await tool.execute({ action: "read", file_path: big, range: "A1:B10000" });
    expect(r.isError).toBeFalsy();
    const maxRows = Math.floor(MAX_RANGE_CELLS / 2); // rows incl. header
    expect(r.metadata).toEqual({ rows: maxRows - 1, columns: 2, truncated: true });
    expect(r.content).toContain(`(range A1:B10000 clamped to A1:B${maxRows} — hard ceiling is ${MAX_RANGE_CELLS} cells`);
  });
});

describe("spreadsheet — workbook size cap", () => {
  it("refuses an over-cap workbook before loading it (read / query / edit)", async () => {
    const calls = [
      { action: "read" },
      { action: "query", column: "Id", operator: "equals", value: "1" },
      { action: "edit", cell: "A1", value: "x" },
    ];
    for (const args of calls) {
      const r = await tool.execute({ ...args, file_path: huge });
      expect(r.isError).toBe(true);
      expect(r.content).toBe(CAP_MSG);
    }
  });

  it("write refuses to merge into an over-cap workbook and leaves it untouched", async () => {
    const before = statSync(huge).size;
    const r = await tool.execute({ action: "write", file_path: huge, data: JSON.stringify([{ a: 1 }]) });
    expect(r.isError).toBe(true);
    expect(r.content).toBe(CAP_MSG);
    expect(statSync(huge).size).toBe(before);
  });
});

describe("spreadsheet write — entity decode + NFC at the cleanText seam", () => {
  it("a cell with entities and a combining accent reads back decoded and composed", async () => {
    const fp = join(dir, "entities.xlsx");
    const w = await tool.execute({
      action: "write",
      file_path: fp,
      data: JSON.stringify([{ Item: "Fish &amp; Chips&#8482; cafe\u0301" }]),
    });
    expect(w.isError).toBeFalsy();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(fp);
    const cell = String(wb.getWorksheet("Sheet1")?.getCell("A2").value);
    // Entities decoded exactly once, combining accent composed to NFC.
    expect(cell).toBe("Fish & Chips\u2122 caf\u00E9");
    expect(cell).not.toContain("\u0301");
  });
});

describe("spreadsheet edit — string values route through the same cleanText seam", () => {
  async function readBack(fp: string, ref: string): Promise<unknown> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(fp);
    return wb.getWorksheet("Sheet1")?.getCell(ref).value;
  }

  it("an edited cell with entities and a combining accent reads back decoded and composed", async () => {
    const fp = await writeSheet("edit-entities.xlsx", [["Item"], ["old"]]);
    const r = await tool.execute({ action: "edit", file_path: fp, cell: "A2", value: "Fish &amp; Chips&#8482; cafe\u0301" });
    expect(r.isError).toBeFalsy();
    const cell = String(await readBack(fp, "A2"));
    // Entities decoded exactly once, combining accent composed to NFC — same seam as write.
    expect(cell).toBe("Fish & Chips\u2122 caf\u00E9");
    expect(cell).not.toContain("\u0301");
  });

  it("formula: true stays byte-preserved even when it looks entity-encoded", async () => {
    const fp = await writeSheet("edit-formula.xlsx", [["A"], [1]]);
    const formula = 'CONCATENATE("&amp;","&#8482;","cafe\u0301")';
    const r = await tool.execute({ action: "edit", file_path: fp, cell: "B1", value: formula, formula: true });
    expect(r.isError).toBeFalsy();
    const v = await readBack(fp, "B1") as { formula?: string };
    expect(v.formula).toBe(formula);
  });

  it('numeric string "02134" keeps the existing edit coercion (becomes the number 2134)', async () => {
    const fp = await writeSheet("edit-zip.xlsx", [["Zip"], ["x"]]);
    const r = await tool.execute({ action: "edit", file_path: fp, cell: "A2", value: "02134" });
    expect(r.isError).toBeFalsy();
    expect(await readBack(fp, "A2")).toBe(2134);
  });

  it("a plain number value lands untouched", async () => {
    const fp = await writeSheet("edit-number.xlsx", [["N"], ["x"]]);
    const r = await tool.execute({ action: "edit", file_path: fp, cell: "A2", value: 42 });
    expect(r.isError).toBeFalsy();
    expect(await readBack(fp, "A2")).toBe(42);
  });
});

describe("spreadsheet query — streamed scan, capped materialization", () => {
  it(`keeps the first ${MAX_ROWS_UNRANGED} matches, counts all of them, and notes the cap`, async () => {
    const r = await tool.execute({ action: "query", file_path: big, column: "Name", operator: "contains", value: "row-" });
    expect(r.isError).toBeFalsy();
    const [table, note] = r.content.split("\n\n");
    expect(table.split("\n")).toHaveLength(MAX_ROWS_UNRANGED + 2);
    expect(note).toBe(`(showing first ${MAX_ROWS_UNRANGED} of ${BIG} matching rows; narrow the filter to see the rest)`);
    expect(r.metadata).toEqual({ matchedRows: BIG, shownRows: MAX_ROWS_UNRANGED, truncated: true });
  });

  it("still finds a match past the cap — the scan is not truncated", async () => {
    const r = await tool.execute({ action: "query", file_path: big, column: "Id", operator: "equals", value: "1400" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe(["| Id   | Name     |", "| ---- | -------- |", "| 1400 | row-1400 |"].join("\n"));
    expect(r.metadata).toEqual({ matchedRows: 1 });
  });

  it("unknown column keeps the same error text", async () => {
    const r = await tool.execute({ action: "query", file_path: big, column: "Nope", operator: "equals", value: "1" });
    expect(r.isError).toBe(true);
    expect(r.content).toBe('Column "Nope" not found. Available: Id, Name');
  });
});

describe("rowsToTable — bounded padding, no spread", () => {
  it("does not throw RangeError on 200k rows (the old Math.max(...spread) did past ~100k)", () => {
    const rows = Array.from({ length: 200_000 }, (_, i) => [String(i), "x"]);
    let out = "";
    expect(() => { out = rowsToTable(["n", "v"], rows); }).not.toThrow();
    expect(out.split("\n")).toHaveLength(200_002);
  });

  it(`caps padding at ${MAX_COL_WIDTH} chars but never truncates the long cell`, () => {
    const long = "x".repeat(MAX_COL_WIDTH * 3);
    const lines = rowsToTable(["h"], [[long], ["y"]]).split("\n");
    expect(lines[1]).toBe(`| ${"-".repeat(MAX_COL_WIDTH)} |`);
    expect(lines[2]).toBe(`| ${long} |`);
    expect(lines[3]).toBe(`| y${" ".repeat(MAX_COL_WIDTH - 1)} |`);
  });
});

describe("clampRange", () => {
  it("passes a range within the ceiling through untouched", () => {
    const req = parseRange("A1:D10");
    expect(clampRange(req)).toEqual({ range: req, note: "" });
  });

  it("cuts rows, keeps columns", () => {
    const { range, note } = clampRange(parseRange("A1:E9999"));
    expect(range).toEqual({ c1: 1, r1: 1, c2: 5, r2: MAX_RANGE_CELLS / 5 });
    expect(note).toContain(`clamped to A1:E${MAX_RANGE_CELLS / 5}`);
  });

  it("refuses a range wider than the ceiling", () => {
    expect(() => clampRange({ r1: 1, c1: 1, r2: 1, c2: MAX_RANGE_CELLS + 1 })).toThrow(/spans 5001 columns/);
  });

  it("leaves an inverted range alone (it reads nothing, as before)", () => {
    const req = parseRange("D5:A1");
    expect(clampRange(req)).toEqual({ range: req, note: "" });
  });
});
