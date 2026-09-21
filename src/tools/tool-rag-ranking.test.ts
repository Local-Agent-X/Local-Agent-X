/**
 * The index returns the MOST RELEVANT tool first.
 *
 * It used to return `allTools.filter(...)`: similarity chose the set and was
 * then thrown away, so the result came back in catalog order and no caller
 * could tell the best match from the last. The tier shrink fills its reserved
 * task slots from the front of this list, so for "delete this file" a weak
 * model was handed edit_lines, multi_edit and bulk_replace — delete_file is the
 * next catalog entry and missed by one. Measured EXP-7c, 2026-09-21: that case
 * went 0/9 across three capped runs against 6/6 uncapped.
 *
 * Pinning made it worse than it sounds: corePinned is every main-chat tool, a
 * pin floors the score at 1.0, and so every tool the chat surface uses tied.
 */
import { describe, it, expect } from "vitest";
import { ToolRAG } from "./tool-rag.js";
import type { ToolDefinition } from "../types.js";

const tool = (name: string): ToolDefinition => ({
  name, description: name, parameters: { type: "object", properties: {} },
  execute: async () => ({ content: "" }),
});

/** One axis per concept, so similarity is exact and the test reads plainly. */
const AXES = ["edit", "delete", "search"];
const vec = (text: string) => AXES.map(a => (text.includes(a) ? 1 : 0.01));

async function indexOf(names: string[]) {
  const rag = new ToolRAG();
  rag.setEmbedder({ embed: async (t: string) => vec(t) });
  const tools = names.map(tool);
  await rag.build(tools);
  return { rag, tools };
}

describe("relevance order survives", () => {
  it("puts the best match first even when it is LAST in the catalog", async () => {
    const { rag, tools } = await indexOf(["edit_lines", "multi_edit", "bulk_edit", "delete_file"]);
    const out = await rag.select("please delete this file", tools, { topK: 10, minScore: 0 });
    expect(out[0].name).toBe("delete_file");
  });

  it("pinning guarantees membership and does NOT flatten the order", async () => {
    const names = ["edit_lines", "multi_edit", "bulk_edit", "delete_file"];
    const { rag, tools } = await indexOf(names);
    // Every tool pinned — exactly how the chat surface calls it.
    const out = await rag.select("please delete this file", tools, { topK: 10, minScore: 0, corePinned: names });
    expect(out.map(t => t.name)).toHaveLength(4);
    expect(out[0].name, "all-pinned tools tied at 1.0 and fell back to catalog order").toBe("delete_file");
  });

  it("ties keep catalog order, so one message always yields one ordering", async () => {
    const { rag, tools } = await indexOf(["edit_lines", "multi_edit", "bulk_edit"]);
    const a = (await rag.select("edit", tools, { topK: 10, minScore: 0 })).map(t => t.name);
    const b = (await rag.select("edit", tools, { topK: 10, minScore: 0 })).map(t => t.name);
    expect(a).toEqual(["edit_lines", "multi_edit", "bulk_edit"]);
    expect(b).toEqual(a);
  });
});
