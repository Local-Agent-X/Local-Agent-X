// Shared types for detectors + the image-detection helper.

export type DetectorKind =
  | "planning-only"
  | "single-action-stop"
  | "reasoning-only"
  | "empty-response"
  | "uncommitted-turn"
  | "evidence-stale";

export interface RetryInstruction {
  kind: DetectorKind;
  instruction: string;
}

export interface TurnState {
  /** Assistant's final visible text this attempt. */
  assistantText: string;
  /** Tool calls the model emitted this attempt. */
  toolCallsThisIteration: Array<{ name: string; arguments?: string }>;
  /** Every tool name called across the full turn (not just this iteration). */
  toolsCalledThisTurn: Set<string>;
  /** True if the model produced any reasoning tokens this attempt. */
  hasReasoning: boolean;
  /** Total completion tokens this attempt (provider-reported). */
  completionTokens: number;
  /** Number of iterations the turn has already run. */
  iteration: number;
  /** Evidence counter (filesRead + searches + tool results + edits). */
  evidenceCount: number;
  /** Evidence count at the start of each iteration — used for staleness. */
  evidenceHistory: number[];
  /**
   * True if the latest user message included an image attachment. When set,
   * the orchestrator skips planning-only / uncommitted-turn / evidence-stale
   * detectors — those misfire on vision replies. The agent's "this is what
   * I see in the picture" is a complete answer, not a stalled plan, but it
   * looks like one to the regex-based detectors and triggers a retry storm
   * (3+ near-identical reply restatements per turn).
   */
  userMessageHasImages?: boolean;
}

/**
 * True if any user message in the array carries an image_url part. Callers
 * pass this through to TurnState.userMessageHasImages.
 */
export function userMessageHasImages(messages: Array<{ role: string; content: unknown }>): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (Array.isArray(m.content)) {
      for (const part of m.content as Array<{ type?: string }>) {
        if (part?.type === "image_url" || part?.type === "image") return true;
      }
    }
    return false; // most recent user message decides — older ones don't matter
  }
  return false;
}
