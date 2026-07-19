import {
  renderPromptSection,
  type RenderedPromptSection,
} from "../context/system-prompt-builder.js";

export function buildVoicePromptPlan(
  base: readonly RenderedPromptSection[],
  voiceTail: string,
): RenderedPromptSection[] {
  return [
    ...base,
    renderPromptSection({
      id: "voice-mode",
      label: "Voice Mode",
      type: "dynamic",
      policy: "required",
      text: voiceTail,
    }),
  ];
}
