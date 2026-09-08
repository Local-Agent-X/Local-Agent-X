import type { LocalModelCapabilityProfile } from "../local-runtimes/index.js";
import type { PromptDegradationTelemetry } from "../prompt-telemetry.js";
import { LOCAL_UNKNOWN_CONTEXT } from "../context-manager/model-windows.js";
// The share (and its 65,536-window derivation) lives with the other window-
// allocation constants in context-manager so the tool-result cap reserves the
// same number this degrader enforces.
import { PROMPT_WINDOW_SHARE } from "../context-manager/request-fit.js";
import type { PromptPriority, RenderedPromptSection } from "./system-prompt-builder.js";

// Class shed order: every section of one class goes before the first section
// of the next. Safety and identity are never shed — identity is "who am I"
// plus, for a heading-less custom prompt, the whole prompt. The 2026-09-08
// overflow (65k window) shed the user's facts and the workspace map and still
// sat over budget with ~22k tokens of behaviour tuning intact; the tuning
// class exists so that is what goes first, largest part first.
const SHED_ORDER: readonly PromptPriority[] = ["tuning", "navigation", "facts"];

/** A section's budget class; the legacy `policy` maps required ⇒ safety, degradable ⇒ facts. */
export function promptPriorityOf(section: Pick<RenderedPromptSection, "policy" | "priority">): PromptPriority {
  return section.priority ?? (section.policy === "required" ? "safety" : "facts");
}

// Kill order WITHIN a class: index 0 is dropped FIRST. Ids absent from this
// list rank after every entry here, in file order (the class decides more
// than this list now — app-manifest and smart-context are in different
// classes, so their relative rank here no longer meets).
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
 * Shed candidates in the order they are dropped: class by class (SHED_ORDER),
 * and within a class by DEGRADATION_PRIORITY rank then file order — except
 * tuning, which goes largest-first so the one 12k-token "How to work" part is
 * the first thing a constrained window gives up, not six small ones.
 */
function shedCandidates(sections: readonly RenderedPromptSection[]): RenderedPromptSection[] {
  const rank = new Map<string, number>(DEGRADATION_PRIORITY.map((id, index) => [id, index]));
  const rankOf = (section: RenderedPromptSection) => rank.get(section.id) ?? Number.MAX_SAFE_INTEGER;
  return SHED_ORDER.flatMap((priorityClass) => {
    const members = sections.filter((section) => promptPriorityOf(section) === priorityClass);
    // Array.prototype.sort is stable, so ties keep file order.
    return priorityClass === "tuning"
      ? members.sort((left, right) => right.measurement.estimatedTokens - left.measurement.estimatedTokens)
      : members.sort((left, right) => rankOf(left) - rankOf(right));
  });
}

/**
 * Deterministically remove whole optional sections when a local context window
 * cannot afford the assembled prompt. Every local target is budgeted at
 * PROMPT_WINDOW_SHARE of its measured window (LOCAL_UNKNOWN_CONTEXT when the
 * window is unknown); tier does not exempt a model from the budget. Cloud
 * targets (null profile) are never touched. Safety and identity sections are
 * never candidates and the surviving order is byte-for-byte unchanged; when
 * they alone exceed the budget the reason says `required-sections-exceed-budget`.
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

  const candidates = shedCandidates(sections);

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
