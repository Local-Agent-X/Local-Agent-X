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

/**
 * "none" — thinking OFF — is a WIRE value, not a rung on the ladder above.
 *
 * REASONING_EFFORTS is the user-selectable depth in settings, and every value
 * there means "think this hard". "none" means "do not think", which is a
 * different question and is not something the user picks per session; it is
 * decided per step from the model profile (local-runtimes/model-profile.ts
 * `thinking.mode`). Keeping it out of REASONING_EFFORTS also keeps it out of
 * normalizeReasoningEffort, so a stray "none" in settings.json still resolves
 * to medium rather than silently disabling thinking everywhere.
 *
 * Only endpoints measured to accept it get it. Verified on Ollama 0.34.2 /v1
 * for both test models (docs/harness/phase0-evidence/probe-results.v1-extras.json,
 * probes 2/8/12/18): HTTP 200, `reasoning_len` 0, and the tool call still
 * emitted. Everywhere else it clamps to "minimal" at the edge.
 */
export type WireReasoningEffort = ReasoningEffort | "none";

export const THINKING_OFF = "none" as const;

/** Chat Completions accepts minimal|low|medium|high — clamp xhigh to high.
 *  "none" passes through ONLY for callers that have checked their endpoint
 *  accepts it; `clampNoneForCloud` is the guard for everyone else. */
export function effortForChatCompletions(
  e: WireReasoningEffort,
): "none" | "minimal" | "low" | "medium" | "high" {
  return e === "xhigh" ? "high" : e;
}

/** An endpoint that has not been measured to accept "none" gets the closest
 *  supported thing instead of a 400. */
export function clampNoneForCloud(e: WireReasoningEffort): ReasoningEffort {
  return e === THINKING_OFF ? "minimal" : e;
}
