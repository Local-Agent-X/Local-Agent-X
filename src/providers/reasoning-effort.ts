/**
 * Canonical reasoning-effort levels — single source of truth for the
 * user-selectable "thinking" depth on reasoning models.
 *
 * One value flows settings.json → resolve-provider → PreparedAgentRequest →
 * adapters. Each wire format maps it at the edge:
 *   - Codex Responses API: sent verbatim (`reasoning.effort`) — xhigh is the
 *     "Max" tier the Codex CLI exposes on gpt-5.x.
 *   - OpenAI Chat Completions (`reasoning_effort`): xhigh isn't a valid value
 *     there — clamp to high via effortForChatCompletions.
 *   - Gemini native / Anthropic CLI: not wired to this knob (Gemini keeps its
 *     boolean thinking flag; the Claude CLI owns its own thinking budget).
 */
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

/** Parse an untrusted settings value; anything unrecognized → medium. */
export function normalizeReasoningEffort(v: unknown): ReasoningEffort {
  return (REASONING_EFFORTS as readonly unknown[]).includes(v)
    ? (v as ReasoningEffort)
    : DEFAULT_REASONING_EFFORT;
}

/**
 * Clamp an effort to a ceiling, ordered per REASONING_EFFORTS. Pure min():
 * never returns a value ABOVE the input effort — a session already below the
 * ceiling passes through untouched. Used by per-step routing to compute
 * min(sessionEffort, "low") for mechanical steps; "low" (not "minimal") is
 * the routing floor because gpt-5.6 rejects minimal (effortForCodexModel,
 * src/codex-client/request.ts).
 */
export function capEffort(effort: ReasoningEffort, ceiling: ReasoningEffort): ReasoningEffort {
  return REASONING_EFFORTS.indexOf(effort) <= REASONING_EFFORTS.indexOf(ceiling)
    ? effort
    : ceiling;
}

/** Chat Completions accepts minimal|low|medium|high — clamp xhigh to high. */
export function effortForChatCompletions(
  e: ReasoningEffort,
): "minimal" | "low" | "medium" | "high" {
  return e === "xhigh" ? "high" : e;
}
