import type { ToolDefinition } from "../types.js";
import type { LocalModelCapabilityProfile } from "../local-runtimes/index.js";
import type { PromptDegradationTelemetry, PromptTelemetry } from "../prompt-telemetry.js";
import { remeasurePromptTelemetry } from "../prompt-telemetry.js";
import type { RenderedPromptSection, SectionAwareSystemPrompt } from "../context/system-prompt-builder.js";
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
  const offered = dispatch.renderedPromptSections;
  const rendered = applyCapabilityAwarePromptDegradation(offered, profile);
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
  logger.info(formatPromptProfileLine(offered, rendered.telemetry));
}

/**
 * One line, sizes included. The 2026-09-08 overflow (65k window, 37k prompt)
 * was logged as `mode=full` with fourteen section NAMES and no numbers, which
 * is why it took a log dive against the adapter's refusal to see that the
 * system prompt alone was 56% of the window. Sizes are token counts only -
 * no section text reaches the log.
 */
export function formatPromptProfileLine(
  offered: readonly RenderedPromptSection[],
  telemetry: PromptDegradationTelemetry,
): string {
  const fullTokens = offered.reduce((sum, section) => sum + section.measurement.estimatedTokens, 0);
  const window = telemetry.localTarget
    ? telemetry.localTarget.contextWindow ?? telemetry.assumedContextWindowTokens ?? "unknown"
    : "n/a";
  const top = [...offered]
    .sort((left, right) => right.measurement.estimatedTokens - left.measurement.estimatedTokens)
    .slice(0, 3)
    .map((section) => `${section.id}:${section.measurement.estimatedTokens}`)
    .join(",");
  return (
    `[prompt-profile] mode=${telemetry.mode} reason=${telemetry.reason} ` +
    `window=${window} budget=${telemetry.promptBudgetTokens ?? "n/a"} full=${fullTokens} ` +
    `top=${top} included=${telemetry.includedSectionIds.join(",")} ` +
    `degraded=${telemetry.degradedSections.map((section) => section.id).join(",")}`
  );
}
