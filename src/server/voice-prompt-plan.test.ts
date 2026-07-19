import { describe, expect, it } from "vitest";
import { renderPromptSection } from "../context/system-prompt-builder.js";
import { buildVoicePromptPlan } from "./voice-prompt-plan.js";

describe("voice prompt plan", () => {
  it("keeps the prepared plan and classifies the voice rider as required", () => {
    const base = [renderPromptSection({
      id: "core", label: "Core", type: "static", policy: "required", text: "core",
    })];
    const plan = buildVoicePromptPlan(base, "voice-tail");

    expect(plan.map((section) => section.text).join("")).toBe("corevoice-tail");
    expect(plan.at(-1)).toMatchObject({
      id: "voice-mode",
      policy: "required",
      text: "voice-tail",
    });
  });
});
