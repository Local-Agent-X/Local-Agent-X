/**
 * The per-turn trace for the hosted adapters (Anthropic, Codex, Gemini): the
 * request as each composed it for its transport and the answer as streamed.
 * The openai-compat adapter builds its own (openai-compat/turn-trace.ts),
 * because it also records the text before tool-call extraction; a hosted
 * provider returns tool calls as structured events, so its raw and kept text
 * are the same.
 *
 * Fields are copied by name, never spread from the transport request, so a
 * credential the request carries (Gemini's apiKey) or the abort signal can
 * never reach a trace file. Pure; the store decides whether to persist it.
 */
import type { TurnTrace } from "../adapter-contract.js";

export interface HostedTraceRequest {
  model: string;
  systemPrompt: string;
  /** Transport-shaped history exactly as handed to the transport. */
  messages: readonly unknown[];
  tools: ReadonlyArray<{ name: string; description?: string; parameters?: unknown }>;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: string;
  toolChoice?: unknown;
  /** Adapter settings that shaped the request but are not the history:
   *  thinking switch, cache split, transport lane. Plain values only. */
  options?: Record<string, string | number | boolean | undefined>;
}

/** What a hosted adapter collected while consuming one turn's stream. */
export interface HostedTurnOutcome {
  text: string;
  thinking: string;
  toolCalls: ReadonlyArray<{ id: string; name: string; arguments: string }>;
  stopReason?: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  firstTokenMs?: number;
  error: { code: string; message: string } | null;
}

export function buildHostedTurnTrace(req: HostedTraceRequest, outcome: HostedTurnOutcome, startedAt: number): TurnTrace {
  const endedAt = Date.now();
  const options = Object.fromEntries(Object.entries(req.options ?? {}).filter(([, v]) => v !== undefined));
  const usageSeen = outcome.promptTokens !== undefined || outcome.completionTokens !== undefined;
  return {
    model: req.model,
    request: {
      systemPrompt: req.systemPrompt,
      messages: [...req.messages],
      tools: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
      ...(req.reasoningEffort ? { reasoningEffort: req.reasoningEffort } : {}),
      ...(req.toolChoice ? { toolChoice: req.toolChoice } : {}),
      ...(Object.keys(options).length > 0 ? { options } : {}),
    },
    response: {
      rawText: outcome.text,
      text: outcome.text,
      thinking: outcome.thinking,
      toolCalls: outcome.toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
      ...(outcome.stopReason ? { stopReason: outcome.stopReason } : {}),
      ...(usageSeen
        ? { usage: { promptTokens: outcome.promptTokens, completionTokens: outcome.completionTokens, cachedTokens: outcome.cachedTokens } }
        : {}),
      ...(outcome.firstTokenMs !== undefined ? { ttftMs: outcome.firstTokenMs } : {}),
      error: outcome.error,
    },
    timing: {
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      modelMs: endedAt - startedAt,
    },
  };
}
