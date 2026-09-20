/**
 * The openai-compat adapter's contribution to the per-turn trace: the request
 * exactly as composed for the client and the stream result before anything
 * rewrote it. Pure; the store decides whether and where to persist it.
 */
import type { ProviderRequest } from "../../../providers/adapter/types.js";
import type { TurnTrace } from "../../adapter-contract.js";
import type { StreamOnceResult } from "./types.js";

export function buildTurnTrace(args: {
  req: ProviderRequest;
  thinking?: { mode: string; kind: string };
  result: StreamOnceResult;
  startedAt: number;
  promptOverWindow: boolean;
}): TurnTrace {
  const { req, result, startedAt, promptOverWindow } = args;
  const endedAt = Date.now();
  const usageSeen = result.usagePromptTokens !== undefined || result.usageCompletionTokens !== undefined;
  return {
    model: req.model,
    ...(req.baseURL ? { baseURL: req.baseURL } : {}),
    request: {
      systemPrompt: req.systemPrompt,
      messages: req.messages as unknown[],
      tools: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
      ...(req.reasoningEffort ? { reasoningEffort: String(req.reasoningEffort) } : {}),
      ...(args.thinking ? { thinking: args.thinking } : {}),
      ...(req.toolChoice ? { toolChoice: req.toolChoice } : {}),
      ...(result.wireParams ? { sent: result.wireParams } : {}),
    },
    response: {
      rawText: result.rawText ?? result.assembledText,
      text: result.assembledText,
      thinking: result.assembledThinking,
      toolCalls: result.pendingToolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
      ...(result.providerStop ? { stopReason: result.providerStop } : {}),
      ...(usageSeen
        ? {
            usage: {
              promptTokens: result.usagePromptTokens,
              completionTokens: result.usageCompletionTokens,
              cachedTokens: result.usageCachedTokens,
            },
          }
        : {}),
      ...(result.firstTokenMs !== undefined ? { ttftMs: result.firstTokenMs } : {}),
      ...(promptOverWindow ? { promptOverWindow: true } : {}),
      ...(result.stoppedByGuard ? { stoppedByGuard: result.stoppedByGuard } : {}),
      error: result.firstError,
    },
    timing: {
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      modelMs: endedAt - startedAt,
    },
  };
}
