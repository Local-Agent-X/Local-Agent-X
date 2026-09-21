/**
 * What the tool-index re-rank does to a capped tier's tool set — pinned as a
 * MEASURED decision, so the next attempt starts from the numbers.
 *
 * With the index warm, tool-selection.ts rebuilds the set from the raw catalog
 * and re-applies the tier shrink at the union's own size: descriptions compact,
 * the tool COUNT is not enforced. That looks like a bug (a weak model's cap is
 * 8 and it can receive the whole union), and EXP-7 through 7d (2026-09-21,
 * docs/harness/HARNESS_LOG.md) treated it as one, four ways:
 *
 *   input tokens   −62% qwen3:8b, −34% qwen3.6:27b — real, held in every variant
 *   qwen3:8b       20/63 → 14, 17, 15, 12 — worse in every variant
 *   qwen3.6:27b    unsafe_action 0 → 2, 1, 2 — failed in every run that measured it
 *
 * The 27B failure is the instructive one: a capped set kept a guessable
 * `delete_file` reachable (the model called it from memory, unlisted, and
 * dispatch ran it) and lost the product-specific `restore_file`, so recovered
 * deletions became unrecovered ones. And nothing here can yet choose WHICH few
 * tools a message needs — the reserve's picks for "delete exactly this file"
 * were start_app_build, browser, presentation.
 *
 * So the count stays unenforced until selection is good enough to deserve a
 * cap. These tests pin the pieces that are right regardless.
 */
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { _resetSessionToolsForTests, selectTools } from "./tool-selection.js";
import { _setToolRAGForTests } from "../../tools/tool-rag.js";
import { applyAudiences } from "../../tools/audience-map.js";
import { ESSENTIAL_TOOLS_ORDER, shrinkToolsForTier } from "../../tools/tier-tool-set.js";
import type { ToolDefinition } from "../../types.js";

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} performs its operation on the target. ` + "Extra detail. ".repeat(30),
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: "" }),
  };
}

function bigCatalog(extra: string[] = []): ToolDefinition[] {
  const names = new Set<string>([...ESSENTIAL_TOOLS_ORDER, "tool_search", ...extra]);
  for (let i = 0; i < 60; i++) names.add(`filler_tool_${i}`);
  const all = [...names].map(tool);
  applyAudiences(all);
  return all;
}

const warmIndexReturningAll = () => ({
  isReady: true,
  select: async (_m: string, allTools: ToolDefinition[]) => allTools,
});

beforeEach(() => _resetSessionToolsForTests());
afterEach(() => _setToolRAGForTests(null));

async function selectFor(model: string, all: ToolDefinition[]): Promise<ToolDefinition[]> {
  const res = await selectTools({
    message: "Hello, how are you today?",
    sessionId: `rag-cap-${model}`,
    channel: "web",
    allAgentTools: all,
    bridgeTools: [],
    resolvedProvider: "ollama",
    resolvedModel: model,
  });
  return res.tools;
}

describe("the re-rank path, as measured", () => {
  it("keeps every re-rank pick for a capped tier — the count is deliberately not enforced", async () => {
    _setToolRAGForTests(warmIndexReturningAll());
    const picked = await selectFor("qwen3:8b", bigCatalog());
    // If this starts failing because someone enforced the cap: read the header
    // and HARNESS_LOG.md EXP-7 first. It has been tried four ways.
    expect(picked.length).toBeGreaterThan(30);
  });

  it("still compacts descriptions for a weak model, which is what 711f2cd6 was for", async () => {
    _setToolRAGForTests(warmIndexReturningAll());
    for (const t of await selectFor("qwen3:8b", bigCatalog())) {
      expect(t.description.length, `${t.name} kept a full-length description`).toBeLessThanOrEqual(200);
    }
  });

  it("never costs the model its core verbs", async () => {
    _setToolRAGForTests(warmIndexReturningAll());
    const names = new Set((await selectFor("qwen3:8b", bigCatalog())).map(t => t.name));
    for (const essential of ESSENTIAL_TOOLS_ORDER.slice(0, 8)) {
      expect(names.has(essential), `${essential} missing`).toBe(true);
    }
  });
});

describe("whenever a set IS capped, a promise-making tool brings its counterpart", () => {
  it("delete_file never ships without restore_file", () => {
    // Exercised on the shrink directly: this is the invariant any future cap
    // inherits. delete_file's result text offers the undo; EXP-7 shipped that
    // sentence without the tool and the 27B's recovered deletions became
    // unrecovered ones. Medium tier, because it has message slots: at the weak
    // cap all 8 slots go to essentials and delete_file does not ship at all.
    const all = bigCatalog(["delete_file", "restore_file"]);
    const asked = [all.find(t => t.name === "delete_file")!];
    const kept = shrinkToolsForTier(asked, "medium", all).map(t => t.name);
    expect(kept).toContain("delete_file");
    expect(kept, "delete_file shipped WITHOUT its undo").toContain("restore_file");
  });

  it("the companion rides outside the cap, so it cannot be the thing that gets evicted", () => {
    const all = bigCatalog(["delete_file", "restore_file"]);
    const asked = [all.find(t => t.name === "delete_file")!];
    // A cap with exactly one message slot: delete_file takes it, and the undo
    // still ships.
    const cap = ESSENTIAL_TOOLS_ORDER.length + 1;
    const kept = shrinkToolsForTier(asked, "medium", all, cap).map(t => t.name);
    expect(kept).toContain("delete_file");
    expect(kept).toContain("restore_file");
  });
});
