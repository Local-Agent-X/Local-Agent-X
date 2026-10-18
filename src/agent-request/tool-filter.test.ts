import { describe, expect, it } from "vitest";
import { TOOL_KEYWORD_MAP } from "./tool-filter.js";
import { collectRuntimeToolNames } from "../tools/runtime-tool-names.js";
import { toolsTagged } from "../tool-registry.js";

// A route whose tags select nothing and whose prefixes match no tool silently
// stops surfacing anything: five such routes (config_, skill_, mission_rollback_,
// mission_chain_, mission_template) sat dead after their tools were removed.
describe("every keyword route reaches a registered tool", () => {
  it("through each of its tags and each of its prefixes", async () => {
    const names = [...(await collectRuntimeToolNames())];
    const dead = TOOL_KEYWORD_MAP.flatMap((route) => [
      ...(route.tags ?? []).filter((tag) => !toolsTagged(tag).some((name) => names.includes(name))).map((tag) => `${route.keywords} tag ${tag}`),
      ...(route.toolPrefixes ?? []).filter((prefix) => !names.some((name) => name.startsWith(prefix))).map((prefix) => `${route.keywords} prefix ${prefix}`),
    ]);
    expect(dead).toEqual([]);
  });

  it("every route names something to surface", () => {
    expect(TOOL_KEYWORD_MAP.filter((route) => (route.tags ?? []).length + (route.toolPrefixes ?? []).length === 0)).toEqual([]);
  });
});
