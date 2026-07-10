import { describe, expect, it } from "vitest";
import { buildDreamPromptForBatch } from "./dream.js";

describe("dream consolidation epistemic grounding", () => {
  it("forbids promoting assistant speculation or weakened qualifiers into facts", () => {
    const prompt = buildDreamPromptForBatch([], 0, 1);
    expect(prompt).toMatch(/Assistant statements.*are NOT evidence/s);
    expect(prompt).toMatch(/recommended.*must never become.*enforced/s);
    expect(prompt).toMatch(/Model-declared provenance is not evidence/);
    expect(prompt).toMatch(/Tool observations.*require interactive user approval/s);
    expect(prompt).toMatch(/runtime, security, policy.*ephemeral/s);
  });
});
