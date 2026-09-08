import { estimateTokens } from "./context-manager/token-estimation.js";
import type { ToolDefinition } from "./types.js";
import { toOAuthWireName } from "./anthropic-client/oauth-direct.js";
import {
  toAnthropicTools,
  toolSchemaFormatForProvider,
  toProviderToolSchemaPayload,
  type ToolSchemaFormat,
} from "./providers/shared/tool-shape.js";
import { isAnthropicCliTransportEnabled } from "./anthropic-client/cli-transport.js";

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
    | "within-prompt-budget"
    | "measured-context-budget"
    | "required-sections-exceed-budget";
  localTarget: {
    runtimeId: string | null;
    model: string;
    contextWindow: number | null;
  } | null;
  /** Present for every local target; absent only for cloud (not-local-target). */
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

/**
 * The tool payload that ACTUALLY goes on the wire for this format.
 *
 * `toProviderToolSchemaPayload()` returns null for `anthropic-dynamic` and
 * `anthropic-cli-managed` on the theory that the CLI subprocess owns the tool
 * definitions. That was true when the CLI transport shipped enabled. It is not
 * true now: `isAnthropicCliTransportEnabled()` is false by default, so
 * `streamAnthropicResponse()` (anthropic-client/stream.ts:36-54) promotes every
 * subscription-shaped credential to the direct-HTTP OAuth path, and
 * `streamViaAPI` (stream-api.ts:208-232) then sets `body.tools =
 * toAnthropicTools(tools, { mapName: toOAuthWireName, cacheControlLast: true })`
 * UNCONDITIONALLY — it never consults ToolSchemaFormat at all.
 *
 * The consequence was that telemetry reported `toolSchemaEstimatedTokens: null`
 * on precisely the lane that pays the largest tool-schema bill (~23,300 est
 * tokens for the 63 main-chat eager tools, measured 2026-09-06), so any attempt
 * to measure prompt cost from this record was blind to about a quarter of it.
 *
 * So: mirror the wire. Null now means what it says — the schemas genuinely are
 * not in OUR request body — and that is only the case when the hidden CLI
 * transport has been re-enabled with LAX_ANTHROPIC_CLI_TRANSPORT=1. Read at
 * call time, like the gate itself, so a toggle takes effect without a restart.
 *
 * The shape is measured, never retained: only the token count survives into the
 * record, so no tool description or schema leaks into telemetry.
 */
function toolSchemaPayloadOnTheWire(
  format: ToolSchemaFormat,
  tools: readonly PromptTelemetryTool[],
): unknown {
  if (format === "anthropic-dynamic" || format === "anthropic-cli-managed") {
    if (isAnthropicCliTransportEnabled()) return null;
    return toAnthropicTools(tools, { mapName: toOAuthWireName, cacheControlLast: true });
  }
  return toProviderToolSchemaPayload(format, tools, {
    mapAnthropicOAuthName: toOAuthWireName,
  });
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
    ? toolSchemaPayloadOnTheWire(toolSchemaFormat, input.tools)
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
