import { describe, it, expect } from "vitest";
import { selectTools } from "./tool-selection.js";
import { buildDeferredToolManifest } from "../../tool-prompt-builder.js";
import { applyAudiences } from "../../tools/audience-map.js";
import type { ToolDefinition } from "../../types.js";

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} tool for tests.`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: "" }),
  };
}

// read/write/bash/grep/glob/tool_search/build_app are main-chat EAGER;
// computer/ocr carry no main-chat audience → DEFERRED. applyAudiences stamps
// them from the canonical AUDIENCES_BY_TOOL map so this mirrors production.
function catalog(): ToolDefinition[] {
  const all = [
    tool("read"), tool("write"), tool("bash"), tool("grep"), tool("glob"),
    tool("tool_search"), tool("build_app"), tool("computer"), tool("ocr"),
  ];
  applyAudiences(all);
  return all;
}

// Benign message: hits no TOOL_FORCING_SIGNAL_RE token, so the LLM intent
// classifier is skipped and selectTools runs deterministically (no network).
const BENIGN = "Hello, how are you today?";

async function selectForAnthropicStrong(all: ToolDefinition[]) {
  return selectTools({
    message: BENIGN,
    channel: "web",
    allAgentTools: all,
    bridgeTools: [],
    resolvedProvider: "anthropic",
    resolvedModel: "claude-opus-4-8",
  });
}

describe("selectTools — Anthropic-strong lazy-load flip", () => {
  it("classifies opus as strong but no longer ships the FULL inventory", async () => {
    const all = catalog();
    const res = await selectForAnthropicStrong(all);
    const names = res.tools.map((t) => t.name);

    expect(res.tier).toBe("strong");
    // eager tools stay in-schema
    expect(names).toContain("read");
    expect(names).toContain("tool_search");
    expect(names).toContain("build_app"); // forceable → must stay present
    // deferred tools drop OUT of the schema (the whole point of the flip)
    expect(names).not.toContain("computer");
    expect(names).not.toContain("ocr");
    // strictly fewer than the whole catalogue
    expect(res.tools.length).toBeLessThan(all.length);
  });

  it("keeps every dropped tool reachable via the manifest (loaded ∪ manifested = catalog)", async () => {
    const all = catalog();
    const res = await selectForAnthropicStrong(all);
    const manifest = buildDeferredToolManifest(all, res.tools);

    for (const t of all) {
      const loaded = res.tools.some((x) => x.name === t.name);
      const manifested = manifest.includes(`- ${t.name}:`);
      expect(loaded || manifested).toBe(true);
    }
    // the specific deferred capabilities are named so the model can tool_search them
    expect(manifest).toContain("- computer:");
    expect(manifest).toContain("- ocr:");
  });
});
