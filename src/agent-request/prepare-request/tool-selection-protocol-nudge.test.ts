/**
 * A LEARNED WORKFLOW nudge tells the model to call `protocol(action:"get")`.
 * The weak and medium essential sets do not carry `protocol`, so without this
 * seam the nudge named a tool the local model did not have — and the
 * imported skill it pointed at was never read (27B skills baseline,
 * 2026-09-23: 0 protocol calls in 12 runs).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../../types.js";

const { _resetSessionToolsForTests, selectTools } = await import("./tool-selection.js");
const { _setToolRAGForTests } = await import("../../tools/tool-rag.js");
const { applyAudiences } = await import("../../tools/audience-map.js");
const { ESSENTIAL_TOOLS_ORDER } = await import("../../tools/tier-tool-set.js");

function tool(name: string): ToolDefinition {
  return { name, description: `${name} does a thing.`, parameters: { type: "object", properties: {} }, execute: async () => ({ content: "" }) };
}

function catalog(): ToolDefinition[] {
  const all = [...new Set<string>([...ESSENTIAL_TOOLS_ORDER, "tool_search", "protocol", "email_send"])].map(tool);
  applyAudiences(all);
  return all;
}

const names = (ts: ToolDefinition[]) => ts.map((t) => t.name);

async function turn(model: string, protocolSuggested: boolean, message = "deploy the acme-site project to vercel as a preview") {
  return names((await selectTools({
    message, sessionId: `nudge-${model}-${protocolSuggested}`, channel: "web", allAgentTools: catalog(), bridgeTools: [],
    resolvedProvider: "local", resolvedModel: model, protocolSuggested,
  })).tools);
}

beforeEach(() => { _resetSessionToolsForTests(); _setToolRAGForTests({ isReady: true, select: async () => [] }); });
afterEach(() => _setToolRAGForTests(null));

describe("the protocol nudge puts the protocol tool in the schema", () => {
  it("a weak local model gets `protocol` only when the prompt will name it", async () => {
    expect(await turn("qwen3:8b", false)).not.toContain("protocol");
    const nudged = await turn("qwen3:8b", true);
    expect(nudged).toContain("protocol");
    expect(nudged).toContain("tool_search");
  });

  it("a medium local model likewise", async () => {
    expect(await turn("qwen3.6:27b", false)).not.toContain("protocol");
    expect(await turn("qwen3.6:27b", true)).toContain("protocol");
  });

  it("a bridge turn is left alone", async () => {
    const bridgeOnly = [tool("bridge_reply")];
    const result = await selectTools({
      message: "deploy to vercel", sessionId: "nudge-bridge", channel: "telegram", allAgentTools: catalog(), bridgeTools: bridgeOnly,
      resolvedProvider: "local", resolvedModel: "qwen3:8b", protocolSuggested: true,
    });
    expect(names(result.tools)).toEqual(["bridge_reply"]);
  });
});
