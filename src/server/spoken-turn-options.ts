/**
 * What a spoken turn can do: exactly what a typed turn can.
 *
 * A spoken turn used to be configured as its own, smaller agent: a belt of 18
 * hand-picked tools where a typed turn had 74, reasoning effort forced to
 * "low" where a typed turn runs at the provider's default or the user's
 * setting, 8 steps where a typed turn has the user's 160, a 4096-token output
 * cap, no forced first tool, and every turn made to call some tool first on
 * OpenAI-compatible runtimes. Each was chosen for speed, and together they
 * made voice say "I don't have his email" or "I can't do that from voice"
 * where the same words typed then worked (2026-11-11).
 *
 * So every setting that decides what the turn can do is read here from the
 * request prepareAgentRequest built, the same one a typed turn runs on
 * (canonical-loop/chat-runner/register-adapter.ts reads the same fields).
 * Voice differs only in how it talks, and those differences live in
 * voice-ws.ts: the voiceModel setting, the "Voice mode" prompt section and
 * its cache split, the local output cap (voice-model.ts), and the op's type.
 * spoken-turn-options.test.ts pins that a value here is the prepared one.
 */
import type { PreparedAgentRequest } from "../agent-request/types.js";
import type { ToolDefinition } from "../types.js";

export interface SpokenTurnAbility {
  tools: ToolDefinition[];
  maxIterations: number;
  temperature: number;
  reasoningEffort: PreparedAgentRequest["reasoningEffort"];
  forcedToolChoice: PreparedAgentRequest["toolChoice"];
  /** A chat turn may simply answer; only a delegated agent must act first. */
  requireToolOnFirstTurn: false;
}

/** The typed turn's tools and settings for a spoken turn. voice_visual (the
 *  sphere) is loaded only while the user has visuals on. */
export function spokenTurnAbility(prepared: PreparedAgentRequest, visualsEnabled: boolean): SpokenTurnAbility {
  return {
    tools: prepared.tools.filter((t) => visualsEnabled || t.name !== "voice_visual"),
    maxIterations: prepared.maxIterations,
    temperature: prepared.temperature,
    reasoningEffort: prepared.reasoningEffort,
    forcedToolChoice: prepared.toolChoice,
    requireToolOnFirstTurn: false,
  };
}
