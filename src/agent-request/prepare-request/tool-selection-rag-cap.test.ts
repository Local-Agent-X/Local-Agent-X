/**
 * CLASS INVARIANT: a warm tool index re-ranks the set, it does not resize it.
 *
 * The instance: when the index is warm, tool-selection.ts rebuilds the set
 * from the RAW catalog and re-applies the tier shrink. 711f2cd6 re-applied it
 * at the union's own size so every re-rank pick would survive — which fixed
 * description compaction and silently disabled the COUNT cap. A weak model,
 * whose cap of 8 exists to stop 0-token paralysis, was handed the whole union
 * on exactly the turns the re-rank fired. More tools with a warm index than a
 * cold one: the cap did the opposite of its job.
 *
 * This branch was unreachable in tests until _setToolRAGForTests, which is
 * why it went unnoticed. Description compaction is asserted here too, so the
 * fix cannot regress what 711f2cd6 was actually for.
 */
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { _resetSessionToolsForTests, selectTools } from "./tool-selection.js";
import { _setToolRAGForTests } from "../../tools/tool-rag.js";
import { applyAudiences } from "../../tools/audience-map.js";
import { ESSENTIAL_TOOLS_ORDER } from "../../tools/tier-tool-set.js";
import type { ToolDefinition } from "../../types.js";

/** Long descriptions on purpose: the weak tier truncates them, and that half
 *  of the prior fix has to keep working. */
function tool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} performs its operation on the target. ` + "Extra detail. ".repeat(30),
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: "" }),
  };
}

/** The essentials plus enough filler to blow past every tier cap. */
function bigCatalog(): ToolDefinition[] {
  const names = new Set<string>([...ESSENTIAL_TOOLS_ORDER, "tool_search"]);
  for (let i = 0; i < 60; i++) names.add(`filler_tool_${i}`);
  const all = [...names].map(tool);
  applyAudiences(all);
  return all;
}

/** A warm index that returns EVERYTHING — the worst case for the union. */
function warmIndexReturningAll() {
  return {
    isReady: true,
    select: async (_m: string, allTools: ToolDefinition[]) => allTools,
  };
}

const BENIGN = "Hello, how are you today?";

beforeEach(() => _resetSessionToolsForTests());
afterEach(() => _setToolRAGForTests(null));

async function selectFor(model: string, all: ToolDefinition[]): Promise<ToolDefinition[]> {
  const res = await selectTools({
    message: BENIGN,
    sessionId: `rag-cap-${model}`,
    channel: "web",
    allAgentTools: all,
    bridgeTools: [],
    resolvedProvider: "ollama",
    resolvedModel: model,
  });
  return res.tools;
}

describe("a warm index cannot inflate a capped tier", () => {
  it("the weak local model stays at its declared cap, not the union's size", async () => {
    _setToolRAGForTests(warmIndexReturningAll());
    const all = bigCatalog();
    const picked = await selectFor("qwen3:8b", all);
    // qwen3:8b's profile declares maxToolsExposed 8, plus tool_search: the
    // discovery tool is deliberately kept OUTSIDE the cap (model-tiers.ts) so
    // a capped model can still reach everything the cap took away. Without
    // the fix this was 89.
    expect(picked.length, `got ${picked.length} tools: ${picked.map(t => t.name).join(",")}`).toBeLessThanOrEqual(9);
    expect(picked.map(t => t.name)).toContain("tool_search");
  });

  it("the medium local model stays at its declared cap too", async () => {
    _setToolRAGForTests(warmIndexReturningAll());
    const picked = await selectFor("qwen3.6:27b", bigCatalog());
    // 30 declared + the out-of-cap discovery tool.
    expect(picked.length, `got ${picked.length}`).toBeLessThanOrEqual(31);
  });

  it("keeps the essentials — the cap must never cost the model its core verbs", async () => {
    _setToolRAGForTests(warmIndexReturningAll());
    const picked = await selectFor("qwen3:8b", bigCatalog());
    const names = new Set(picked.map(t => t.name));
    // The weak cap is 8 and essentials are pulled in priority order, so the
    // first 8 of ESSENTIAL_TOOLS_ORDER are the contract. A cap that evicted
    // read/write/bash would be the capability-filter hazard, not a fix.
    for (const essential of ESSENTIAL_TOOLS_ORDER.slice(0, 8)) {
      expect(names.has(essential), `${essential} was evicted by the cap`).toBe(true);
    }
  });

  it("still compacts descriptions, which is what the prior fix was for", async () => {
    _setToolRAGForTests(warmIndexReturningAll());
    const picked = await selectFor("qwen3:8b", bigCatalog());
    for (const t of picked) {
      expect(t.description.length, `${t.name} kept a full-length description`).toBeLessThanOrEqual(200);
    }
  });

  it("a cold index gives the same size as a warm one — the cap is not a function of index state", async () => {
    const all = bigCatalog();
    _setToolRAGForTests({ isReady: false, select: async (_m, t) => t });
    const cold = await selectFor("qwen3:8b", all);
    _resetSessionToolsForTests();
    _setToolRAGForTests(warmIndexReturningAll());
    const warm = await selectFor("qwen3:8b", all);
    expect(warm.length).toBe(cold.length);
  });

  it("a model with no profile is untouched — cloud keeps its tier cap", async () => {
    _setToolRAGForTests(warmIndexReturningAll());
    const res = await selectTools({
      message: BENIGN,
      sessionId: "rag-cap-cloud",
      channel: "web",
      allAgentTools: bigCatalog(),
      bridgeTools: [],
      resolvedProvider: "anthropic",
      resolvedModel: "claude-opus-4-8",
    });
    const picked = res.tools;
    // Strong is uncapped by tier, and the RAG branch's shrink is skipped for
    // it entirely, so the union survives exactly as before this change.
    expect(picked.length).toBeGreaterThan(30);
  });
});

/**
 * The cap decides SIZE. It must not decide capability independently of the
 * task, and it must never void a guarantee the product already made.
 *
 * Both failures are measured, EXP-7, 2026-09-21:
 *  - qwen3:8b, "delete exactly this file": 3/3 → 0/3 with NO tool called at
 *    all, because delete_file is in no essentials position and a weak model
 *    had zero slots left for the task.
 *  - qwen3.6:27b, restraint: delete_file survived the cap and restore_file
 *    did not, so three recovered deletions became three unrecovered ones and
 *    unsafe_action went 0 → 2.
 */
describe("the cap reserves room for the task", () => {
  it("a weak model gets message-relevant tools, not just the top of a static list", async () => {
    const all = bigCatalog();
    all.push(...[tool("delete_file"), tool("restore_file")]);
    applyAudiences(all);
    // A warm index that ranks the deletion tool first, the way a real
    // re-rank would for a deletion request.
    _setToolRAGForTests({
      isReady: true,
      select: async (_m: string, t: ToolDefinition[]) => {
        const del = t.filter(x => x.name === "delete_file");
        return [...del, ...t.filter(x => x.name !== "delete_file")];
      },
    });
    const picked = await selectFor("qwen3:8b", all);
    const names = picked.map(t => t.name);
    expect(names, `got: ${names.join(",")}`).toContain("delete_file");
  });

  it("a tool that promises an undo brings the undo, cap or no cap", async () => {
    const all = bigCatalog();
    all.push(...[tool("delete_file"), tool("restore_file")]);
    applyAudiences(all);
    _setToolRAGForTests({
      isReady: true,
      select: async (_m: string, t: ToolDefinition[]) => {
        const del = t.filter(x => x.name === "delete_file");
        return [...del, ...t.filter(x => x.name !== "delete_file")];
      },
    });
    for (const model of ["qwen3:8b", "qwen3.6:27b"]) {
      _resetSessionToolsForTests();
      const names = (await selectFor(model, all)).map(t => t.name);
      expect(names, `${model} got delete_file`).toContain("delete_file");
      expect(names, `${model} shipped delete_file WITHOUT restore_file`).toContain("restore_file");
    }
  });

  it("the core verbs still survive the reserve", async () => {
    _setToolRAGForTests(warmIndexReturningAll());
    const names = new Set((await selectFor("qwen3:8b", bigCatalog())).map(t => t.name));
    for (const core of ["read", "write", "edit", "bash", "http_request"]) {
      expect(names.has(core), `${core} was evicted by the task reserve`).toBe(true);
    }
  });

  it("the reserve does not blow the size budget open again", async () => {
    _setToolRAGForTests(warmIndexReturningAll());
    const picked = await selectFor("qwen3:8b", bigCatalog());
    // cap 8 + tool_search. Companions ride outside the cap by design, but
    // none apply here, so this pins that the reserve only REDISTRIBUTES.
    expect(picked.length, `got ${picked.length}`).toBeLessThanOrEqual(9);
  });
});
