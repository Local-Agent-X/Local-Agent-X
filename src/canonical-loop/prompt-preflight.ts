import type { ToolDefinition } from "../types.js";
import type { LocalModelCapabilityProfile } from "../local-runtimes/index.js";
import type { PromptTelemetry } from "../prompt-telemetry.js";
import { remeasurePromptTelemetry } from "../prompt-telemetry.js";
import type { SectionAwareSystemPrompt } from "../context/system-prompt-builder.js";
import { applyCapabilityAwarePromptDegradation } from "../context/prompt-degradation.js";
import type { OpenAICompatTarget } from "./adapters/openai-compat.js";
import { createLogger } from "../logger.js";

const logger = createLogger("canonical-loop.prompt-preflight");

export interface CapabilityAwarePromptDispatch extends SectionAwareSystemPrompt {
  provider: string;
  apiKey: string;
  model: string;
  baseURL?: string;
  customBaseURL?: string;
  tools: ToolDefinition[];
  promptTelemetry?: PromptTelemetry;
  localModelCapabilityProfile?: LocalModelCapabilityProfile | null;
}

/**
 * Resolve one exact local target, render its section-aware prompt, and return
 * that same target for adapter registration. Non-local dispatches are a no-op.
 */
export async function preflightCapabilityAwarePrompt(
  dispatch: CapabilityAwarePromptDispatch,
): Promise<OpenAICompatTarget | null> {
  if (dispatch.provider !== "local") return null;

  const { localModelEvidenceForResolvedTarget, resolveOpenAICompatTarget } =
    await import("./adapters/openai-compat/resolve-target.js");
  const target = await resolveOpenAICompatTarget(
    dispatch.provider,
    { apiKey: dispatch.apiKey, customBaseURL: dispatch.customBaseURL ?? dispatch.baseURL },
    dispatch.model,
  );
  if (!target) {
    throw new Error("provider local has no usable OpenAI-compat target — check API key and base URL config");
  }

  applyCapabilityAwarePromptProfile(
    dispatch,
    localModelEvidenceForResolvedTarget(dispatch.provider, target),
  );
  return target;
}

export function applyCapabilityAwarePromptProfile(
  dispatch: CapabilityAwarePromptDispatch,
  profile: LocalModelCapabilityProfile | null,
): void {
  dispatch.localModelCapabilityProfile = profile;
  const rendered = applyCapabilityAwarePromptDegradation(dispatch.renderedPromptSections, profile);
  dispatch.systemPrompt = rendered.prompt;
  dispatch.renderedPromptSections = rendered.sections;
  if (dispatch.promptTelemetry) {
    dispatch.promptTelemetry = remeasurePromptTelemetry({
      baseline: dispatch.promptTelemetry,
      prompt: rendered.prompt,
      tools: dispatch.tools,
      sections: rendered.sections.map((section) => section.measurement),
      degradation: rendered.telemetry,
    });
  }
  logger.info(
    `[prompt-profile] mode=${rendered.telemetry.mode} reason=${rendered.telemetry.reason} ` +
    `included=${rendered.telemetry.includedSectionIds.join(",")} ` +
    `degraded=${rendered.telemetry.degradedSections.map((section) => section.id).join(",")}`,
  );
}
