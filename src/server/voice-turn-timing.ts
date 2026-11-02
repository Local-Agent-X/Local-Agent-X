/**
 * Where a spoken turn's wait goes before its first word. The turn machine's
 * `[timing]` line (voice-session/turn-runner.ts) reports `ttft` as one span from
 * the final transcript to the first token; this splits that span into the steps
 * the server takes, so a slow reply points at the step that is slow:
 *
 *   slot     waiting for the session's turn slot (a typed turn still running)
 *   load     reading the persisted thread back
 *   prepare  prepareAgentRequest: persona, memory recall, provider resolution
 *   plan     picking the spoken model, tools and prompt
 *   model    from the model call to its first streamed token
 *
 * Each step is the time since the one before it, so the parts add up to the
 * whole. Steps the turn never reached print as "-".
 */

export type VoiceTurnPhase = "slot" | "load" | "prepare" | "plan";

const PHASES: readonly VoiceTurnPhase[] = ["slot", "load", "prepare", "plan"];

export interface VoiceTurnClock {
  /** End of a step: records the time since the previous step ended. */
  mark(phase: VoiceTurnPhase): void;
  /** The model's first token. Only the first call counts. */
  firstToken(): void;
  /** The `[timing]` log line for this turn. */
  line(sessionId: string, model: string): string;
}

export function createVoiceTurnClock(now: () => number = Date.now): VoiceTurnClock {
  const spans = new Map<VoiceTurnPhase | "model", number>();
  let last = now();
  return {
    mark(phase) {
      const t = now();
      spans.set(phase, t - last);
      last = t;
    },
    firstToken() {
      if (!spans.has("model")) spans.set("model", now() - last);
    },
    line(sessionId, model) {
      const parts = [...PHASES, "model" as const].map((p) => `${p}=${spans.has(p) ? `${spans.get(p)}ms` : "-"}`);
      return `[timing] voice-turn ${sessionId} (${model}) ${parts.join(" ")}`;
    },
  };
}
