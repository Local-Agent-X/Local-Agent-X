import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { createPromptTelemetry, remeasurePromptTelemetry } from "../../prompt-telemetry.js";
import { toolSchemaFormatForDispatch } from "../../providers/shared/tool-shape.js";
import { applyCapabilityAwarePromptProfile } from "../prompt-preflight.js";
import type { LocalModelCapabilityProfile } from "../../local-runtimes/index.js";
import type { CanonicalAgentOptions } from "./types.js";

/** Final section-aware prompt seam shared by every non-chat canonical caller. */
export async function prepareCanonicalAgentPrompt(
  options: CanonicalAgentOptions,
  history: ChatCompletionMessageParam[],
  profile: LocalModelCapabilityProfile | null,
): Promise<void> {
  const plannedPrompt = options.renderedPromptSections.map((section) => section.text).join("");
  if (plannedPrompt !== options.systemPrompt) {
    throw new Error("Canonical agent prompt sections do not match systemPrompt bytes");
  }

  if (!options.promptTelemetry) {
    options.promptTelemetry = createPromptTelemetry({
      profile: "full",
      provider: options.provider,
      model: options.model,
      prompt: options.systemPrompt,
      tools: options.tools,
      allToolCount: options.tools.length,
      historyMessageCount: history.length,
      sections: options.renderedPromptSections.map((section) => section.measurement),
    });
  }

  applyCapabilityAwarePromptProfile(options, profile);
  const toolSchemaFormat = toolSchemaFormatForDispatch(
    options.provider,
    options.promptTelemetry.toolSchemaFormat,
    options.preferAnthropicDirectHttp === true,
  );
  options.promptTelemetry = remeasurePromptTelemetry({
    baseline: options.promptTelemetry,
    prompt: options.systemPrompt,
    tools: options.tools,
    historyMessageCount: history.length,
    toolSchemaFormat,
    sections: options.renderedPromptSections.map((section) => section.measurement),
  });
}
