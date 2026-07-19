import { estimateTokens } from "./context-manager/token-estimation.js";
import type { ToolDefinition } from "./types.js";
import { toOAuthWireName } from "./anthropic-client/oauth-direct.js";
import {
  toolSchemaFormatForProvider,
  toProviderToolSchemaPayload,
  type ToolSchemaFormat,
} from "./providers/shared/tool-shape.js";

type PromptTelemetryTool = Pick<ToolDefinition, "name" | "description" | "parameters">;

export interface PromptSectionTelemetry {
  id: string;
  type: "static" | "dynamic";
  characters: number;
  utf8Bytes: number;
  estimatedTokens: number;
}

export interface PromptDegradationTelemetry {
  mode: "full" | "constrained-local";
  contextEvidence: "not-local" | "unknown" | "measured";
  toolEvidence: "not-local" | "unknown" | "advertised" | "verified" | "rejected";
  reason:
    | "not-local-target"
    | "unknown-context-within-conservative-budget"
    | "unknown-context-conservative-budget"
    | "capability-not-constrained"
    | "within-prompt-budget"
    | "measured-context-budget"
    | "required-sections-exceed-budget";
  localTarget: {
    runtimeId: string | null;
    model: string;
    contextWindow: number | null;
  } | null;
  promptBudgetTokens?: number;
  assumedContextWindowTokens?: number;
  includedSectionIds: string[];
  degradedSections: Array<{
    id: string;
    reason: "measured-context-budget" | "unknown-context-conservative-budget";
  }>;
}

export interface PromptTelemetry {
  version: 2;
  recordedAt: string;
  profile: "full" | "voice";
  provider: string;
  model: string;
  characters: number;
  utf8Bytes: number;
  estimatedTokens: number;
  toolSchemaFormat: ToolSchemaFormat;
  toolSchemaEstimatedTokens: number | null;
  loadedToolCount: number;
  deferredToolCount: number;
  historyMessageCount: number;
  sections: PromptSectionTelemetry[];
  /** Content-free record of capability-aware prompt rendering. */
  degradation?: PromptDegradationTelemetry;
}

export function measurePromptSection(
  id: string,
  type: PromptSectionTelemetry["type"],
  text: string,
): PromptSectionTelemetry {
  return {
    id,
    type,
    characters: text.length,
    utf8Bytes: Buffer.byteLength(text, "utf8"),
    estimatedTokens: estimateTokens(text),
  };
}

export function createPromptTelemetry(input: {
  profile: PromptTelemetry["profile"];
  provider: string;
  model: string;
  authSource?: string;
  toolSchemaFormat?: ToolSchemaFormat;
  prompt: string;
  tools: readonly PromptTelemetryTool[];
  allToolCount: number;
  historyMessageCount: number;
  sections: PromptSectionTelemetry[];
  degradation?: PromptDegradationTelemetry;
}): PromptTelemetry {
  const toolSchemaFormat = input.toolSchemaFormat
    ?? toolSchemaFormatForProvider(input.provider, input.authSource);
  const toolSchemaPayload = input.tools.length > 0
    ? toProviderToolSchemaPayload(toolSchemaFormat, input.tools, {
        mapAnthropicOAuthName: toOAuthWireName,
      })
    : null;
  return {
    version: 2,
    recordedAt: new Date().toISOString(),
    profile: input.profile,
    provider: input.provider,
    model: input.model,
    characters: input.prompt.length,
    utf8Bytes: Buffer.byteLength(input.prompt, "utf8"),
    estimatedTokens: estimateTokens(input.prompt),
    toolSchemaFormat,
    toolSchemaEstimatedTokens: input.tools.length === 0
      ? 0
      : toolSchemaPayload === null
        ? null
        : estimateTokens(JSON.stringify(toolSchemaPayload)),
    loadedToolCount: input.tools.length,
    deferredToolCount: Math.max(0, input.allToolCount - input.tools.length),
    historyMessageCount: input.historyMessageCount,
    sections: input.sections,
    ...(input.degradation ? { degradation: input.degradation } : {}),
  };
}

export function remeasurePromptTelemetry(input: {
  baseline: PromptTelemetry;
  prompt: string;
  tools: readonly PromptTelemetryTool[];
  provider?: string;
  model?: string;
  toolSchemaFormat?: ToolSchemaFormat;
  historyMessageCount?: number;
  sections?: PromptSectionTelemetry[];
  appendedSection?: { id: string; type: PromptSectionTelemetry["type"]; text: string };
  degradation?: PromptDegradationTelemetry;
}): PromptTelemetry {
  const baselineSections = input.sections ?? input.baseline.sections;
  const sections = input.appendedSection?.text
    ? [...baselineSections, measurePromptSection(
        input.appendedSection.id,
        input.appendedSection.type,
        input.appendedSection.text,
      )]
    : baselineSections;

  const provider = input.provider ?? input.baseline.provider;
  return createPromptTelemetry({
    profile: input.baseline.profile,
    provider,
    model: input.model ?? input.baseline.model,
    toolSchemaFormat: input.toolSchemaFormat
      ?? (provider === input.baseline.provider
        ? input.baseline.toolSchemaFormat
        : toolSchemaFormatForProvider(provider)),
    prompt: input.prompt,
    tools: input.tools,
    allToolCount: input.baseline.loadedToolCount + input.baseline.deferredToolCount,
    historyMessageCount: input.historyMessageCount ?? input.baseline.historyMessageCount,
    sections,
    degradation: input.degradation ?? input.baseline.degradation,
  });
}
