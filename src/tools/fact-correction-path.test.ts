import { describe, it, expect } from "vitest";
import { ESSENTIAL_TOOLS_ORDER, GEMINI_STRONG_TOOL_CAP, shrinkToolsForTier } from "./tier-tool-set.js";
import { createFactsTools } from "../memory/tools/facts.js";
import type { MemoryIndex } from "../memory/index.js";
import type { ToolDefinition } from "../types.js";

// LM Studio eval 2026-10-18 (qwen3.6-27b, medium tier): told "she moved it,
// it's at slip 31 now", the model had remember and forget but no update_fact —
// forget's own description says "A correction is update_fact" — so it saved
// the new slip beside the old one, and the stale slip 14 stayed current. The
// Ollama build of the same model only got there by calling update_fact by name
// from the system prompt.
function tool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} does a thing that is described at some length for a strong model to read.`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: "" }),
  } as unknown as ToolDefinition;
}

const catalog = [
  ...ESSENTIAL_TOOLS_ORDER.map(tool),
  ...Array.from({ length: 80 }, (_, i) => tool(`filler_${i}`)),
  // Last, so it can't win a message-matched slot: only the companion rule gets it in.
  tool("update_fact"),
];

describe("a capped model that can forget a fact can also correct it", () => {
  it("forget's description points corrections at update_fact", () => {
    const forget = createFactsTools({} as MemoryIndex).find((t) => t.name === "forget")!;
    expect(forget.description).toContain("update_fact");
  });

  it("the medium set ships update_fact beside remember and forget", () => {
    const kept = shrinkToolsForTier(catalog, "medium", catalog).map((t) => t.name);
    for (const name of ["remember", "forget", "update_fact"]) expect(kept).toContain(name);
  });

  it("rides outside the cap: no essential is displaced, under the medium cap or Gemini's", () => {
    const medium = shrinkToolsForTier(catalog, "medium", catalog).map((t) => t.name);
    for (const name of ESSENTIAL_TOOLS_ORDER) expect(medium).toContain(name);
    const gemini = shrinkToolsForTier(catalog, "medium", catalog, GEMINI_STRONG_TOOL_CAP).map((t) => t.name);
    expect(gemini).toEqual(expect.arrayContaining(ESSENTIAL_TOOLS_ORDER.slice(0, GEMINI_STRONG_TOOL_CAP)));
    expect(gemini).toContain("update_fact");
  });

  it("a weak set without forget gets no update_fact either", () => {
    const weak = shrinkToolsForTier(catalog, "weak", catalog).map((t) => t.name);
    expect(weak).not.toContain("forget");
    expect(weak).not.toContain("update_fact");
  });
});
