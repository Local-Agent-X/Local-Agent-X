import { describe, expect, it } from "vitest";
import {
  classifyModel,
  shrinkToolsForTier,
  maxToolsForTier,
  toolCapTierForProvider,
  ESSENTIAL_TOOLS_ORDER,
  MEDIUM_INTENT_SLOTS,
  GEMINI_STRONG_TOOL_CAP,
} from "../src/model-tiers.js";

/**
 * Regression guard (live 2026-07-15, local qwen3.6:27b, "build me a side
 * scroller like super mario"): build_app was absent from the model's schema,
 * so the model — whose function-calling was working fine, it called
 * memory_search correctly in the same turn — improvised bash("build_app
 * --name ...") and looped on exit_code=127 "build_app: command not found".
 *
 * Chain: :27b has no weak rule -> tier "medium" -> cap was a hand-written 21
 * whose comment claimed "19 essentials + 2 intent slots" while the list had
 * grown to 20 -> 1 slot of real headroom -> build_app (not an essential) lost
 * it in raw catalog order. The RAG re-rank that would have unioned it back in
 * only runs when the index is warm, so the bug was intermittent — which is why
 * a todo app built earlier and the platformer didn't.
 */
describe("build_app survives the medium-tier shrink (local model regression)", () => {
  // The real catalog is ~167 tools; 60 is plenty to force the cap and keeps
  // build_app deliberately LATE in catalog order — the losing position it was
  // actually in. If the essentials guarantee regresses, it drops out again.
  const makeRealisticCatalog = () => {
    const essentials = ESSENTIAL_TOOLS_ORDER.filter((n) => n !== "build_app").map((name) => ({
      name,
      description: `Essential tool ${name}.`,
    }));
    const filler = Array.from({ length: 40 }, (_, i) => ({
      name: `unrelated_tool_${i}`,
      description: `Unrelated tool number ${i}.`,
    }));
    // Last: worst-case catalog position, exactly where it lost the slot.
    return [...essentials, ...filler, { name: "build_app", description: "Build a complete web app." }];
  };

  it("classifies a 27B local model as medium (not weak, not strong)", () => {
    // The tier that got it capped. If this ever flips, the cap math below
    // stops being the thing that protects build_app and this file is a lie.
    expect(classifyModel("qwen3.6:27b")).toBe("medium");
  });

  it("keeps build_app in the schema for a medium local model asking for a build", () => {
    const catalog = makeRealisticCatalog();
    const out = shrinkToolsForTier(catalog, classifyModel("qwen3.6:27b"), catalog);
    expect(out.map((t) => t.name)).toContain("build_app");
  });

  it("keeps build_app even when the prefilter dropped it (pulled from allTools)", () => {
    // filterToolsForMessage only force-includes build_app when the intent
    // classifier or BUILD_INTENT_REGEX fires. Both missed here: the classifier
    // timed out at 8s on the 27B, and "build me a side scroller" contains no
    // "app". So the filtered set genuinely lacked build_app and the essentials
    // pull from the full catalog is the only thing that saves it.
    const catalog = makeRealisticCatalog();
    const prefiltered = catalog.filter((t) => t.name !== "build_app");
    const out = shrinkToolsForTier(prefiltered, "medium", catalog);
    expect(out.map((t) => t.name)).toContain("build_app");
  });

  it("leaves real headroom for message-matched tools after the essentials", () => {
    // The actual defect: essentials consumed 20 of 21 slots, so "what the user
    // asked for" got a single slot. Assert the headroom exists rather than
    // asserting a magic number, so appending an essential can't silently eat it.
    expect(maxToolsForTier("medium") - ESSENTIAL_TOOLS_ORDER.length).toBe(MEDIUM_INTENT_SLOTS);
    expect(MEDIUM_INTENT_SLOTS).toBeGreaterThan(0);
  });

  it("actually admits intent-matched non-essential tools alongside the essentials", () => {
    // Stronger than the arithmetic above: prove the headroom is reachable.
    const essentials = ESSENTIAL_TOOLS_ORDER.map((name) => ({ name, description: `Essential ${name}.` }));
    const intentMatched = [
      { name: "email_send", description: "Send an email." },
      { name: "calendar_create", description: "Create a calendar event." },
    ];
    const out = shrinkToolsForTier([...intentMatched, ...essentials], "medium", [...essentials, ...intentMatched]);
    const names = out.map((t) => t.name);
    expect(names).toContain("email_send");
    expect(names).toContain("calendar_create");
  });
});

describe("tier shrink — no collateral from adding build_app", () => {
  it("does not evict memory_save from the weak tier (build_app sits below the cut)", () => {
    // build_app is intentionally placed after index 8. Promoting it above the
    // weak cap would silently drop memory_save from every 1-13B model.
    expect(ESSENTIAL_TOOLS_ORDER.indexOf("build_app")).toBeGreaterThanOrEqual(maxToolsForTier("weak"));
    const catalog = ESSENTIAL_TOOLS_ORDER.map((name) => ({ name, description: `Essential ${name}.` }));
    const out = shrinkToolsForTier(catalog, "weak");
    expect(out.map((t) => t.name)).toContain("memory_save");
    expect(out.map((t) => t.name)).not.toContain("build_app");
  });

  it("pins the Gemini endpoint cap independently of the medium tier count", () => {
    // These were the same number (21) and silently coupled: bumping medium for
    // model-capacity reasons would have shoved Gemini past Google's documented
    // 10-20 ceiling for an unrelated reason. They must be free to diverge.
    expect(toolCapTierForProvider("gemini", "gemini-2.5-pro")).toBe("medium");
    expect(GEMINI_STRONG_TOOL_CAP).toBe(21);
    const catalog = Array.from({ length: 60 }, (_, i) => ({
      name: `tool_${i}`,
      description: `Tool ${i}.`,
    }));
    const out = shrinkToolsForTier(catalog, "medium", catalog, GEMINI_STRONG_TOOL_CAP);
    expect(out.length).toBe(GEMINI_STRONG_TOOL_CAP);
  });
});
