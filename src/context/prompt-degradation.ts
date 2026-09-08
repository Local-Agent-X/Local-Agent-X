import type { LocalModelCapabilityProfile } from "../local-runtimes/index.js";
import type { PromptDegradationTelemetry } from "../prompt-telemetry.js";
import { LOCAL_UNKNOWN_CONTEXT } from "../context-manager/model-windows.js";
import type { RenderedPromptSection } from "./system-prompt-builder.js";

// The prompt budget is a SHARE of the measured window, applied to every local
// target. It used to sit behind an absolute gate (window > 32,768 and tier !==
// "weak" => full prompt, no budget at all), which silently exempted every
// 33k-128k local model: on 2026-09-08 a 65,536-token model was handed a 36,978
// token system prompt (56% of its window), the 23-tool medium manifest took
// another ~13,600 (fixed overhead 77%), and the third tool step overflowed.
// A relative budget only means something if it is applied relatively.
//
// Why 0.35, sized on the 65,536 window that exposed the bug:
//   budget            = floor(65,536 * 0.35)            = 22,937
//   tool manifest     ~ 13,617 (medium tier, 23 tools, measured 2026-09-08)
//   response reserve  =  1,024 (openai-compat preflight)
//   left for messages = 65,536 - 22,937 - 13,617 - 1,024 = 27,958  (42.7%)
// The floor we want is ~40% of the window for the conversation; the share that
// hits exactly 40% on this model is (65,536 - 26,214 - 13,617 - 1,024) / 65,536
// = 0.377, so 0.35 clears it with margin and gets roomier as windows grow
// (131,072: 51% left). Below ~48k the tool manifest, not this share, is the
// dominant fixed cost (32k medium: 23% left) - that is the tier picker's lever
// (maxToolsForTier), not a second knob here.
//
// This is a sizing policy only: required prompt sections can exceed it, and
// when they do the reason says so instead of the budget being quietly ignored.
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
 * Deterministically remove whole optional sections when a local context window
 * cannot afford the assembled prompt. Every local target is budgeted at
 * PROMPT_WINDOW_SHARE of its measured window (LOCAL_UNKNOWN_CONTEXT when the
 * window is unknown); tier does not exempt a model from the budget. Cloud
 * targets (null profile) are never touched. Required sections are never
 * candidates and the surviving order is byte-for-byte unchanged.
 */
export function applyCapabilityAwarePromptDegradation(
  sections: readonly RenderedPromptSection[],
  profile: LocalModelCapabilityProfile | null,
): CapabilityAwarePromptResult {
  if (!profile) return fullPromptResult(sections, "not-local-target", null);

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
    result.telemetry.promptBudgetTokens = promptBudgetTokens;
    if (profile.contextWindow === null) {
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
