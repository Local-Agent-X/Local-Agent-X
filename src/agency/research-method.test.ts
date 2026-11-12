// Deep research is written once (research-method.ts): the researcher role and
// the Deep Researcher template both carry it, and a saved Deep Researcher that
// still has its first prompt is moved to it without touching a user's edits.
import { describe, expect, it } from "vitest";
import { DEEP_RESEARCH_CLAIMS, DEEP_RESEARCH_METHOD } from "./research-method.js";
import { getRole } from "./agent-roles.js";
import { builtInTemplateDefaults, deepResearcherPromptRefresh, DEEP_RESEARCHER_OLD_OPENING } from "../agent-store/template-defaults.js";

describe("the one deep research method", () => {
  it("is carried whole by the researcher role and the Deep Researcher template", () => {
    const template = builtInTemplateDefaults().find((t) => t.id === "builtin-deep-researcher")!;
    for (const prompt of [getRole("researcher")!.systemPrompt, template.systemPrompt]) {
      expect(prompt).toContain(DEEP_RESEARCH_METHOD);
      expect(prompt).toContain(DEEP_RESEARCH_CLAIMS);
    }
    // The worker's own rules stay: it has no channel back to the user, and it pivots when a source fails.
    expect(template.systemPrompt).toContain("NEVER ask the user to clarify");
    expect(template.systemPrompt).toContain("When a source fails");
    expect(template.systemPrompt).not.toContain(DEEP_RESEARCHER_OLD_OPENING);
  });

  it("says what the old prompts left out", () => {
    expect(DEEP_RESEARCH_METHOD).toContain("cite only pages you opened");
    expect(DEEP_RESEARCH_METHOD).toContain("count as one source");
    expect(DEEP_RESEARCH_METHOD).toContain("counter-evidence");
    expect(DEEP_RESEARCH_METHOD).toContain("Check the date");
  });

  it("moves a saved Deep Researcher off its first prompt, keeping what followed the opening", () => {
    const saved = `${DEEP_RESEARCHER_OLD_OPENING}\n\nYou were spawned with one task. MY OWN EXTRA RULE.`;
    const next = deepResearcherPromptRefresh(saved)!;
    expect(next).toContain(DEEP_RESEARCH_METHOD);
    expect(next.endsWith("\n\nYou were spawned with one task. MY OWN EXTRA RULE.")).toBe(true);
    // Already moved, or the user's own prompt: left alone.
    expect(deepResearcherPromptRefresh(next)).toBeNull();
    expect(deepResearcherPromptRefresh("You are my custom researcher.")).toBeNull();
  });
});
