import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HoldoutError, isSealed, listScenarios, readScenariosForJudge, sealSuite, writeScenario } from "./store.js";
import { holdoutRoot, projectHoldoutDir } from "./paths.js";

const DATA = mkdtempSync(join(tmpdir(), "lax-holdout-store-"));
const prior = process.env.LAX_DATA_DIR;
beforeAll(() => { process.env.LAX_DATA_DIR = DATA; });
afterAll(() => {
  if (prior === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prior;
  rmSync(DATA, { recursive: true, force: true });
});

describe("holdout store", () => {
  it("lives under the data dir, outside every project", () => {
    expect(holdoutRoot()).toBe(join(DATA, "holdout"));
    expect(projectHoldoutDir("petbook")).toBe(join(DATA, "holdout", "petbook"));
  });

  it("refuses a project or file name that is not one plain name", () => {
    expect(projectHoldoutDir("../x")).toBeNull();
    expect(projectHoldoutDir("a/b")).toBeNull();
    expect(() => writeScenario("../x", "a.md", "x")).toThrow(HoldoutError);
    expect(() => writeScenario("petbook", "../a.md", "x")).toThrow(HoldoutError);
    expect(() => writeScenario("petbook", "a.txt", "x")).toThrow(HoldoutError);
  });

  it("writes, lists and reads scenarios for the judge, then refuses changes once sealed", () => {
    expect(writeScenario("petbook", "first-pet.md", "A visitor adds a pet.").replaced).toBe(false);
    expect(writeScenario("petbook", "first-pet.md", "A visitor adds two pets.").replaced).toBe(true);
    writeScenario("petbook", "delete-pet.md", "They delete it.");
    expect(listScenarios("petbook")).toEqual(["delete-pet.md", "first-pet.md"]);
    expect(isSealed("petbook")).toBe(false);
    expect(sealSuite("petbook").scenarios).toHaveLength(2);
    expect(isSealed("petbook")).toBe(true);
    expect(() => writeScenario("petbook", "late.md", "x")).toThrow(/sealed/);
    expect(readScenariosForJudge("petbook").map((s) => s.content)).toEqual(["They delete it.", "A visitor adds two pets."]);
  });

  it("will not seal an empty suite", () => {
    expect(() => sealSuite("empty")).toThrow(HoldoutError);
    expect(existsSync(join(DATA, "holdout", "empty", ".sealed"))).toBe(false);
  });
});
