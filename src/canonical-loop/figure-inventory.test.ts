// The figures a check counts and chooses from. Before, the verifier picked
// "3-7 load-bearing values" whatever the deck's size, and the note could not
// say how much was looked at (owner's call, 2026-11-24: scale with the deck,
// show the count).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { figuresInLine, inventoryFigures, routineSampleSize, spreadPick, type Figure } from "./figure-inventory.js";

describe("what counts as a figure on a line", () => {
  it.each([
    ["Hawaii — 48.31", ["48.31"]],
    ["A gap of 35.06¢/kWh", ["35.06¢/kWh"]],
    ["Hawaii's price was 3.65× Nevada's", ["3.65×"]],
    ["Revenue rose 17.3% to $4.2 billion", ["17.3%", "$4.2 billion"]],
    ["1,204 MWh generated", ["1,204 MWh"]],
  ])("%s", (line, expected) => {
    expect(figuresInLine(line)).toEqual(expected);
  });

  it.each([
    ["September 2026 · Cents per kilowatt-hour"],
    ["Released November 24, 2026"],
    ["The 5 most expensive and 5 cheapest states"],
    ["EIA Electric Power Monthly, Table 5.6.A"],
    ["Source: EIA, 48.31 cents"],
    ["https://www.eia.gov/electricity/monthly/epm_table_grapher.php?t=5"],
    ["3. Kentucky"],
  ])("none in: %s", (line) => {
    expect(figuresInLine(line)).toEqual([]);
  });
});

describe("a deliverable's figures", () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "lax-figures-")); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("are listed by place, a repeat on one place counted once, ids stable by place and order", async () => {
    const md = join(dir, "report.md");
    writeFileSync(md, "# Prices\nHawaii 48.31¢ and Maine 31.29¢.\nHawaii again 48.31¢.\n\n# Gap\nA gap of 35.06¢/kWh, up 4.2%.\n");
    const figures = await inventoryFigures(md);
    expect(figures?.map((f) => [f.id, f.where, f.value])).toEqual([
      ["s1#1", "Prices", "48.31¢"],
      ["s1#2", "Prices", "31.29¢"],
      ["s2#1", "Gap", "35.06¢/kWh"],
      ["s2#2", "Gap", "4.2%"],
    ]);
  });

  it("a kind it cannot read lists nothing (the verifier picks its own)", async () => {
    const xlsx = join(dir, "prices.xlsx");
    writeFileSync(xlsx, "not really a workbook");
    expect(await inventoryFigures(xlsx)).toBeNull();
  });
});

describe("how many a routine check covers", () => {
  it.each([[3, 3], [7, 7], [16, 10], [40, 16], [100, 31]])("%i figures: %i", (total, n) => {
    expect(routineSampleSize(total)).toBe(n);
  });

  it("spreads them one per place before any place gets a second", () => {
    const f = (id: string) => ({ id, where: "", value: "", context: "" }) as Figure;
    const figures = [f("slide2#1"), f("slide2#2"), f("slide2#3"), f("slide3#1"), f("slide3#2"), f("slide4#1")];
    expect(spreadPick(figures, 4).map((x) => x.id)).toEqual(["slide2#1", "slide3#1", "slide4#1", "slide2#2"]);
  });
});
