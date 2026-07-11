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

/** Chat Completions accepts minimal|low|medium|high — clamp xhigh to high. */
export function effortForChatCompletions(
  e: ReasoningEffort,
): "minimal" | "low" | "medium" | "high" {
  return e === "xhigh" ? "high" : e;
}
