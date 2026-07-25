import type { LocalModelCapabilityProfile } from "../local-runtimes/index.js";
import type { PromptDegradationTelemetry } from "../prompt-telemetry.js";
import { LOCAL_UNKNOWN_CONTEXT } from "../context-manager/model-windows.js";
import type { RenderedPromptSection } from "./system-prompt-builder.js";

const CONSTRAINED_CONTEXT_WINDOW = 32_768;
// Leave the majority for tool schemas, history, tool results, and output.
// This is a sizing policy only: required prompt sections can exceed it.
const PROMPT_WINDOW_SHARE = 0.35;

// Kill order: index 0 is dropped FIRST. Ids absent from this list rank after
// every entry here, so they are dropped last.
const DEGRADATION_PRIORITY = [
  "app-manifest",
  "smart-context",
  "integrations",
  "project-catalog",
  "context-block",
  "relevant-memories",
  "memory-orchestrator",
  "memory-curate",
  // Ranked last on purpose. The protocol-load notice used to ride inside
  // smart-context (index 1), so on any constrained or weak local profile
  // retrieval died second — the agent lost the pointer to the procedure it
  // had already learned, on exactly the models least able to reconstruct it.
  // It is ~50 tokens and it is the only section that changes what the model
  // DOES rather than what it knows, so it now outlives every other optional
  // section. The trade, stated plainly: whatever previously died last now dies
  // second-to-last, and because the notice adds its own tokens to the budget a
  // marginal prompt can shed one extra section. On a DEFAULT install that
  // victim is `memory-orchestrator`, not `memory-curate` — memoryCurateBlock is
  // empty unless LAX_MEMORY_INPROMPT_NUDGE=1 (prepare-request.ts), so
  // `memory-curate` is usually not a rendered section at all.
  "learned-protocol",
] as const;

export interface CapabilityAwarePromptResult {
  prompt: string;
  sections: RenderedPromptSection[];
  telemetry: PromptDegradationTelemetry;
}

function toolEvidence(profile: LocalModelCapabilityProfile | null): PromptDegradationTelemetry["toolEvidence"] {
  if (!profile) return "not-local";
  if (profile.tools.rejectsTools) return "rejected";
  if (profile.tools.verified === true) return "verified";
  if (profile.tools.advertised === true) return "advertised";
  return "unknown";
}

function fullPromptResult(
  sections: readonly RenderedPromptSection[],
  reason: PromptDegradationTelemetry["reason"],
  profile: LocalModelCapabilityProfile | null,
): CapabilityAwarePromptResult {
  return {
    prompt: sections.map((section) => section.text).join(""),
    sections: [...sections],
    telemetry: {
      mode: "full",
      contextEvidence: !profile ? "not-local" : profile.contextWindow === null ? "unknown" : "measured",
      toolEvidence: toolEvidence(profile),
      reason,
      localTarget: profile
        ? { runtimeId: profile.runtimeId, model: profile.model, contextWindow: profile.contextWindow }
        : null,
      includedSectionIds: sections.map((section) => section.id),
      degradedSections: [],
    },
  };
}

/**
 * Deterministically remove whole optional sections when a measured local
 * context window cannot afford the assembled prompt. Required sections are
 * never candidates and the surviving order is byte-for-byte unchanged.
 */
export function applyCapabilityAwarePromptDegradation(
  sections: readonly RenderedPromptSection[],
  profile: LocalModelCapabilityProfile | null,
): CapabilityAwarePromptResult {
  if (!profile) return fullPromptResult(sections, "not-local-target", null);
  if (profile.contextWindow !== null &&
      profile.contextWindow > CONSTRAINED_CONTEXT_WINDOW &&
      profile.tier !== "weak") {
    return fullPromptResult(sections, "capability-not-constrained", profile);
  }

  const contextWindow = profile.contextWindow ?? LOCAL_UNKNOWN_CONTEXT;
  const promptBudgetTokens = Math.floor(contextWindow * PROMPT_WINDOW_SHARE);
  const fullTokens = sections.reduce((sum, section) => sum + section.measurement.estimatedTokens, 0);
  if (fullTokens <= promptBudgetTokens) {
    const result = fullPromptResult(
      sections,
      profile.contextWindow === null
        ? "unknown-context-within-conservative-budget"
        : "within-prompt-budget",
      profile,
    );
    if (profile.contextWindow === null) {
      result.telemetry.promptBudgetTokens = promptBudgetTokens;
      result.telemetry.assumedContextWindowTokens = LOCAL_UNKNOWN_CONTEXT;
    }
    return result;
  }

  const priority = new Map<string, number>(
    DEGRADATION_PRIORITY.map((id, index) => [id, index]),
  );
  const candidates = sections
    .filter((section) => section.policy === "degradable")
    .sort((left, right) => {
      const leftRank = priority.get(left.id) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = priority.get(right.id) ?? Number.MAX_SAFE_INTEGER;
      return leftRank - rightRank || left.id.localeCompare(right.id);
    });

  let remainingTokens = fullTokens;
  const omitted = new Set<string>();
  for (const section of candidates) {
    if (remainingTokens <= promptBudgetTokens) break;
    omitted.add(section.id);
    remainingTokens -= section.measurement.estimatedTokens;
  }

  const included = sections.filter((section) => !omitted.has(section.id));
  const budgetReason = profile.contextWindow === null
    ? "unknown-context-conservative-budget" as const
    : "measured-context-budget" as const;
  const stillOverBudget = remainingTokens > promptBudgetTokens;
  return {
    prompt: included.map((section) => section.text).join(""),
    sections: included,
    telemetry: {
      mode: omitted.size > 0 ? "constrained-local" : "full",
      contextEvidence: profile.contextWindow === null ? "unknown" : "measured",
      toolEvidence: toolEvidence(profile),
      reason: omitted.size > 0 && !stillOverBudget ? budgetReason : "required-sections-exceed-budget",
      localTarget: {
        runtimeId: profile.runtimeId,
        model: profile.model,
        contextWindow: profile.contextWindow,
      },
      promptBudgetTokens,
      ...(profile.contextWindow === null
        ? { assumedContextWindowTokens: LOCAL_UNKNOWN_CONTEXT }
        : {}),
      includedSectionIds: included.map((section) => section.id),
      degradedSections: candidates
        .filter((section) => omitted.has(section.id))
        .map((section) => ({ id: section.id, reason: budgetReason })),
    },
  };
}
