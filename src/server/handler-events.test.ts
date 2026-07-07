import { describe, it, expect } from "vitest";
import { buildExecutionRules } from "./handler-events.js";

// The supervisor-side delegation guidance (config/system-prompt.md) promises:
// workers report a result whose first sentence carries the outcome (the
// parent surfaces only a ~180-char preview), and workers never delegate
// further. These tests pin the worker-side execution rules to that contract.
describe("buildExecutionRules", () => {
  const variants = [
    { name: "worktree worker", rules: buildExecutionRules("Linux/macOS. bash runs /bin/bash.", 60, true) },
    { name: "workspace worker", rules: buildExecutionRules("Linux/macOS. bash runs /bin/bash.", 60, false) },
  ];

  for (const { name, rules } of variants) {
    it(`${name}: tells the worker to lead its final report with the outcome`, () => {
      expect(rules).toContain("Final report: lead with the concrete outcome");
      expect(rules).toContain("short preview");
    });

    it(`${name}: never instructs sub-delegation (workers cannot spawn workers)`, () => {
      expect(rules).not.toMatch(/agent_spawn|sub-?worker|spawn (an? )?agent|delegate/i);
    });

    it(`${name}: keeps the core loop discipline rules`, () => {
      expect(rules).toContain("EXECUTION RULES:");
      expect(rules).toContain("Platform: Linux/macOS. bash runs /bin/bash.");
      expect(rules).toContain("If a tool fails twice with the same args, switch tools or arguments.");
    });
  }

  it("floors the tool-call budget at 40", () => {
    expect(buildExecutionRules("x", 5, false)).toContain("~40 tool calls max");
    expect(buildExecutionRules("x", 120, false)).toContain("~120 tool calls max");
  });

  it("worktree variant keeps save-as-you-go; workspace variant forbids repo-source edits", () => {
    expect(variants[0].rules).toContain("Save results to workspace/ as you go");
    expect(variants[1].rules).toContain("Don't edit repo source.");
  });
});
