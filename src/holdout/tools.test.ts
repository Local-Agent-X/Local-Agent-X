import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holdoutSealTool, holdoutWriteTool } from "./tools.js";
import { readScenariosForJudge } from "./store.js";

const DATA = mkdtempSync(join(tmpdir(), "lax-holdout-tools-"));
const prior = process.env.LAX_DATA_DIR;
beforeAll(() => { process.env.LAX_DATA_DIR = DATA; });
afterAll(() => {
  if (prior === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prior;
  rmSync(DATA, { recursive: true, force: true });
});

const SECRET = "The visitor sees exactly three pets in a grid.";

describe("holdout_write / holdout_seal", () => {
  it("writes a scenario without echoing it, then seals and lists file names only", async () => {
    const wrote = await holdoutWriteTool.execute({ project: "petbook", filename: "01-grid.md", content: SECRET });
    expect(wrote.isError).toBeFalsy();
    expect(wrote.content).not.toContain("three pets");
    const sealed = await holdoutSealTool.execute({ project: "petbook" });
    expect(sealed.isError).toBeFalsy();
    expect(sealed.content).toContain("01-grid.md");
    expect(sealed.content).not.toContain("three pets");
    expect(readScenariosForJudge("petbook")[0].content).toBe(SECRET);
  });

  it("refuses a change after the seal, and a bad name, as a tool error", async () => {
    const late = await holdoutWriteTool.execute({ project: "petbook", filename: "02-late.md", content: "x" });
    expect(late.isError).toBe(true);
    expect(late.content).toMatch(/sealed/);
    const bad = await holdoutWriteTool.execute({ project: "../etc", filename: "a.md", content: "x" });
    expect(bad.isError).toBe(true);
  });

  it("sealing twice is harmless; sealing nothing is refused", async () => {
    expect((await holdoutSealTool.execute({ project: "petbook" })).content).toMatch(/^Already sealed/);
    expect((await holdoutSealTool.execute({ project: "nothing-here" })).isError).toBe(true);
  });
});
