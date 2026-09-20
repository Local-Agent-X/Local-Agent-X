// The escape hatch cannot be the thing that gets trimmed.
//
// Every trimmed schema tells the model what to do about a tool it cannot see:
// arg-validation's unknown-tool text says "call tool_search to load it", and
// the deferred-tool manifest promises "EVERY AVAILABLE TOOL IS REACHABLE — each
// one is either in `loaded` or named here". Both are void if tool_search itself
// was trimmed, and it was: it sits at catalog position 17, the medium tier's
// two intent slots go to whatever comes first in catalog order (edit_lines,
// multi_edit), and the only re-add lived inside a Gemini-only branch.
//
// Live 2026-09-19: a local 27B asked for a deck with photos called image_search
// (named by the presentation tool's own failure text), was told the tool did
// not exist, was told to call tool_search, and did not have that either. The
// deck shipped with no images and the user read it as the model lying.
import { describe, it, expect } from "vitest";
import { shrinkToolsForTier, maxToolsForTier, ESSENTIAL_TOOLS_ORDER, DISCOVERY_TOOL, type ModelTier } from "../src/model-tiers.js";

interface FakeTool { name: string; description: string; parameters?: Record<string, unknown> }
const tool = (name: string): FakeTool => ({ name, description: `${name} does a thing.` });

// The catalog in registry order, with the discovery tool where it really sits:
// well past both tier caps, behind the editing tools that win the intent slots.
const CATALOG: FakeTool[] = [
  ...ESSENTIAL_TOOLS_ORDER.map(tool),
  tool("edit_lines"), tool("multi_edit"), tool("bulk_replace"),
  tool("image_search"), tool(DISCOVERY_TOOL), tool("youtube_analyze"),
];

const names = (ts: FakeTool[]): string[] => ts.map((t) => t.name);

describe("tool_search survives every tier shrink", () => {
  for (const tier of ["weak", "medium"] as ModelTier[]) {
    it(`is present at the ${tier} tier`, () => {
      const kept = shrinkToolsForTier(CATALOG, tier, CATALOG);
      expect(names(kept)).toContain(DISCOVERY_TOOL);
    });

    it(`costs the ${tier} tier no capability slot`, () => {
      const kept = shrinkToolsForTier(CATALOG, tier, CATALOG);
      // Everything except the discovery tool still fits the tier's own cap, so
      // adding it evicted nothing — it rides outside the budget by design.
      expect(kept.filter((t) => t.name !== DISCOVERY_TOOL).length).toBe(Math.min(maxToolsForTier(tier), CATALOG.length - 1));
    });
  }

  it("keeps the weak tier's capability set exactly as it was", () => {
    const kept = names(shrinkToolsForTier(CATALOG, "weak", CATALOG));
    expect(kept.filter((n) => n !== DISCOVERY_TOOL)).toEqual(ESSENTIAL_TOOLS_ORDER.slice(0, maxToolsForTier("weak")));
  });

  it("never duplicates it when the caller already selected it", () => {
    const withDiscovery = [tool(DISCOVERY_TOOL), ...CATALOG];
    const kept = names(shrinkToolsForTier(withDiscovery, "medium", withDiscovery));
    expect(kept.filter((n) => n === DISCOVERY_TOOL)).toHaveLength(1);
  });

  it("does not invent it when the catalog genuinely lacks it", () => {
    const without = CATALOG.filter((t) => t.name !== DISCOVERY_TOOL);
    expect(names(shrinkToolsForTier(without, "medium", without))).not.toContain(DISCOVERY_TOOL);
  });

  it("leaves the strong tier untouched", () => {
    const kept = shrinkToolsForTier(CATALOG, "strong", CATALOG);
    expect(names(kept)).toEqual(names(CATALOG));
  });
});
