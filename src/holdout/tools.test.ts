import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holdoutSealTool, holdoutWriteTool, SCENARIO_FORMAT, untestableReason } from "./tools.js";
import { readScenariosForJudge, sealSuite, writeScenario } from "./store.js";

const DATA = mkdtempSync(join(tmpdir(), "lax-holdout-tools-"));
const prior = process.env.LAX_DATA_DIR;
beforeAll(() => { process.env.LAX_DATA_DIR = DATA; });
afterAll(() => {
  if (prior === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prior;
  rmSync(DATA, { recursive: true, force: true });
});

const shaped = (expectation: string): string => [
  "# Scenario: the pet grid",
  "",
  "**Persona:** a visitor",
  "**Steps:**",
  "1. They open the home page",
  "",
  "**Satisfaction criteria:**",
  `- ${expectation}`,
].join("\n");
const SECRET = shaped("They see exactly three pets in a grid.");
const PROSE = "A visitor opens the home page. They should see exactly three pets in a grid.";

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
    const late = await holdoutWriteTool.execute({ project: "petbook", filename: "02-late.md", content: shaped("x") });
    expect(late.isError).toBe(true);
    expect(late.content).toMatch(/sealed/);
    const changed = await holdoutWriteTool.execute({ project: "petbook", filename: "01-grid.md", content: shaped("They see any pets at all.") });
    expect(changed.isError).toBe(true);
    expect(readScenariosForJudge("petbook")[0].content).toBe(SECRET);
    const bad = await holdoutWriteTool.execute({ project: "../etc", filename: "a.md", content: shaped("x") });
    expect(bad.isError).toBe(true);
  });

  it("sealing twice is harmless; sealing nothing is refused", async () => {
    expect((await holdoutSealTool.execute({ project: "petbook" })).content).toMatch(/^Already sealed/);
    expect((await holdoutSealTool.execute({ project: "nothing-here" })).isError).toBe(true);
  });
});

// The tool asked for "plain prose" and the judge needs numbered steps: every
// scenario of two builds was written the first way and never run (2026-11-26).
describe("a scenario the judge could not run", () => {
  it("the tool's own description gives the shape the judge needs, and that shape is one it can run", () => {
    expect(holdoutWriteTool.description).toContain(SCENARIO_FORMAT);
    expect(untestableReason(SCENARIO_FORMAT)).toBeNull();
    expect(untestableReason(PROSE)).toMatch(/Steps/);
  });

  it("is refused when written, with the shape to write it in, and nothing is stored", async () => {
    const out = await holdoutWriteTool.execute({ project: "pillbox", filename: "01-grid.md", content: PROSE });
    expect(out.isError).toBe(true);
    expect(out.content).toContain(SCENARIO_FORMAT);
    expect(out.content).not.toContain("three pets");
    expect(readScenariosForJudge("pillbox")).toEqual([]);
  });

  it("already sealed, it can be replaced by one the judge can run; a sealed scenario that runs cannot", async () => {
    writeScenario("label", "01-prose.md", PROSE);
    writeScenario("label", "02-fine.md", SECRET);
    sealSuite("label");

    const fixed = await holdoutWriteTool.execute({ project: "label", filename: "01-prose.md", content: SECRET });
    expect(fixed.isError).toBeFalsy();
    expect(fixed.content).toMatch(/^Replaced 01-prose\.md/);
    // Fixed once, it is a test like any other: sealed.
    const again = await holdoutWriteTool.execute({ project: "label", filename: "01-prose.md", content: shaped("anything") });
    expect(again.isError).toBe(true);
    const weakened = await holdoutWriteTool.execute({ project: "label", filename: "02-fine.md", content: shaped("anything") });
    expect(weakened.isError).toBe(true);
    const added = await holdoutWriteTool.execute({ project: "label", filename: "03-new.md", content: SECRET });
    expect(added.isError).toBe(true);
    expect(readScenariosForJudge("label").map((s) => s.content)).toEqual([SECRET, SECRET]);
  });
});
