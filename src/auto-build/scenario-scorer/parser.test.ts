// What the judge can drive, pinned on real text. The suites of two builds were
// prose paragraphs (the first case below is one of them, reworded): the parser
// refused each, and until 2026-11-26 nothing else noticed.
import { describe, expect, it } from "vitest";
import { parseScenarioText } from "./parser.js";

const PROSE = "Sam types \"willow bark\" and runs a check while no cloud config is present. The result should say the " +
  "lookup ran on the stand-in. It should not say it ran in the cloud.";

const SHAPED = [
  "# Scenario: lookup without cloud config",
  "",
  "**Persona:** Sam, checking a supplement before buying it",
  "**Context:** no cloud config is present",
  "**Steps:**",
  "1. They type \"willow bark\" into the ingredient box",
  "2. They press Check",
  "   and wait for the result",
  "",
  "**Satisfaction criteria:**",
  "- The result says the lookup ran on the stand-in",
  "- It does not say it ran in the cloud",
  "",
  "**Kind:** checkable",
].join("\n");

describe("parseScenarioText", () => {
  it("a prose paragraph has no steps to perform, and is refused by name", () => {
    expect(() => parseScenarioText(PROSE, "06-where-it-ran.md")).toThrow(/06-where-it-ran\.md has no Steps: list/);
  });

  it("reads the shape the writing tool asks for: title, persona, ordered steps, criteria", () => {
    const s = parseScenarioText(SHAPED, "01.md");
    expect(s.title).toBe("Scenario: lookup without cloud config");
    expect(s.persona).toBe("Sam, checking a supplement before buying it");
    expect(s.steps).toEqual(["They type \"willow bark\" into the ingredient box", "They press Check and wait for the result"]);
    expect(s.passCriteria).toContain("ran on the stand-in");
  });

  it("takes bullets for steps and the older \"Pass criteria\" label", () => {
    const s = parseScenarioText("# S\n\n**Steps:**\n- open the page\n- add a pet\n\n**Pass criteria:** the pet is listed", "02.md");
    expect(s.steps).toEqual(["open the page", "add a pet"]);
    expect(s.passCriteria).toBe("the pet is listed");
  });

  it("a Steps heading with nothing under it is still no steps", () => {
    expect(() => parseScenarioText("# S\n\n**Steps:**\n\n**Satisfaction criteria:**\n- x", "03.md")).toThrow(/no Steps/);
  });
});
