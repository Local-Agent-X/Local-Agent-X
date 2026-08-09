// Voice prompt-cache split (buildVoicePromptSplit).
//
// The base system prompt interleaves per-turn dynamic sections (memory
// retrieval, notices) with the large static prefix in one string, so
// consecutive voice turns were byte-different and missed the Anthropic
// prompt cache on the whole tools+system tier every turn. The split
// reorders to [static, voice tail, dynamic] and reports where the stable
// bytes end so stream-api can put the cache breakpoint on the stable block.
import { describe, expect, it } from "vitest";
import { renderPromptSection, type RenderedPromptSection } from "../context/system-prompt-builder.js";
import { buildVoicePromptSplit } from "./voice-prompt-plan.js";

function section(id: string, type: "static" | "dynamic", text: string): RenderedPromptSection {
  return renderPromptSection({ id, label: id, type, policy: "required", text });
}

const TAIL = "\n\n## Voice mode\nshort spoken replies";

describe("buildVoicePromptSplit", () => {
  it("moves the voice tail into the stable prefix, ahead of dynamic sections", () => {
    const base = [
      section("persona", "static", "PERSONA."),
      section("tools", "static", "TOOLS."),
      section("memory", "dynamic", "MEMORY-THIS-TURN."),
    ];
    const split = buildVoicePromptSplit(base, "PERSONA.TOOLS.MEMORY-THIS-TURN.", TAIL);

    expect(split.systemPrompt).toBe("PERSONA.TOOLS." + TAIL + "MEMORY-THIS-TURN.");
    expect(split.stableLen).toBe(("PERSONA.TOOLS." + TAIL).length);
    expect(split.fullyStable).toBe(false);
    // The section plan mirrors the actual string order — telemetry and local
    // degradation both assume plan text ≡ prompt text.
    expect(split.sections.map((s) => s.id)).toEqual(["persona", "tools", "voice-mode", "memory"]);
    expect(split.sections.map((s) => s.text).join("")).toBe(split.systemPrompt);
    expect(split.sections.find((s) => s.id === "voice-mode")).toMatchObject({ policy: "required" });
  });

  it("reports fullyStable (no split point) when a turn renders no dynamic sections", () => {
    const base = [section("persona", "static", "PERSONA.")];
    const split = buildVoicePromptSplit(base, "PERSONA.", TAIL);

    expect(split.systemPrompt).toBe("PERSONA." + TAIL);
    expect(split.stableLen).toBeUndefined();
    expect(split.fullyStable).toBe(true);
  });

  it("falls back to append-only (no split) when sections don't reassemble the base prompt", () => {
    // An override path that bypassed the section builder: the string and the
    // plan disagree. Splitting would ship a prompt that diverges from what
    // the caller prepared — legacy shape instead.
    const base = [section("persona", "static", "PERSONA.")];
    const split = buildVoicePromptSplit(base, "SOMETHING-ELSE.", TAIL);

    expect(split.systemPrompt).toBe("SOMETHING-ELSE." + TAIL);
    expect(split.stableLen).toBeUndefined();
    expect(split.fullyStable).toBe(false);
    expect(split.sections.map((s) => s.id)).toEqual(["persona", "voice-mode"]);
  });

  it("keeps dynamic-only prompts intact (everything volatile after the tail)", () => {
    const base = [section("notice", "dynamic", "NOTICE.")];
    const split = buildVoicePromptSplit(base, "NOTICE.", TAIL);

    expect(split.systemPrompt).toBe(TAIL + "NOTICE.");
    expect(split.stableLen).toBe(TAIL.length);
    expect(split.fullyStable).toBe(false);
  });
});
