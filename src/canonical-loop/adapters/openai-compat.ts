/**
 * OpenAI-compatible canonical adapter.
 *
 * Covers every provider whose wire protocol is OpenAI Chat Completions:
 * Ollama (local + Turbo cloud), xAI Grok, OpenAI direct, Gemini's
 * OpenAI-compat layer, Together / OpenRouter / any custom OpenAI-shape
 * endpoint. The differences between them are baseURL + apiKey + model
 * name. That's it. So one adapter handles all of them — caller passes
 * the resolved `baseURL` + `apiKey` and we stream, accumulate, finalize.
 *
 * Mirrors `codex.ts` shape: convert canonical messages →
 * ChatCompletionMessageParam[], hand off to the existing
 * `OllamaHttpAdapter` (which inherits OpenAIHttpAdapter — same code
 * path used by the legacy `runStandardAgent`), and report stream/tool/
 * done events back through the canonical contract.
 *
 * Stateless: no Codex-style `previousResponseId` chaining. Each turn
 * re-sends full history. provider_state is just `lastTurnIdx`, model,
 * and usage.
 *
 * Empty-response retry: if a turn produces zero text + zero tool calls
 * after sending tools, we retry once without tools and call
 * markNoToolSupport so subsequent turns skip the dead first leg.
 * Catches qwen2's silent-fail pattern (cf. the explicit-error fallback
 * already inside OllamaHttpAdapter). For models that don't have this
 * failure mode (gpt-5, grok, etc.), the condition just never fires.
 *
 * Helpers split into ./openai-compat/* — this file is the adapter class.
 */
import type { Adapter, AdapterReport, TurnInput, TurnResult } from "../adapter-contract.js";
import type { CanonicalMessage, ProviderStateEnvelope } from "../contract-types.js";
import type { ProviderRequest } from "../../providers/adapter/types.js";
import { markNoToolSupport } from "../../providers/types.js";
import { createLogger } from "../../logger.js";

import {
  OPENAI_COMPAT_ADAPTER_NAME,
  OPENAI_COMPAT_ADAPTER_VERSION,
  PROVIDER_STATE_MAX_BYTES,
  type OpenAICompatAdapterOptions,
  type StreamOnceResult,
} from "./openai-compat/types.js";
import { byteLengthUtf8 } from "./openai-compat/helpers.js";
import { canonicalToChatParam } from "./openai-compat/canonical-to-chat-param.js";
import { streamOnce, applyToolCallTextFallback } from "./openai-compat/stream-once.js";

export { OPENAI_COMPAT_ADAPTER_NAME, OPENAI_COMPAT_ADAPTER_VERSION } from "./openai-compat/types.js";
export type { OpenAICompatAdapterOptions, OpenAICompatTarget } from "./openai-compat/types.js";
export { resolveOpenAICompatTarget } from "./openai-compat/resolve-target.js";

const logger = createLogger("canonical-loop.adapters.openai-compat");

export class OpenAICompatAdapter implements Adapter {
  readonly name = OPENAI_COMPAT_ADAPTER_NAME;
  readonly version = OPENAI_COMPAT_ADAPTER_VERSION;

  private aborted = false;
  private aborter: AbortController = new AbortController();
  private inflight: Promise<StreamOnceResult> | null = null;

  constructor(private readonly opts: OpenAICompatAdapterOptions) {}

  async runTurn(input: TurnInput, report: (r: AdapterReport) => void): Promise<TurnResult> {
    if (this.aborted) {
      report({ kind: "error", code: "aborted", message: "adapter aborted before runTurn", retryable: false });
      return { providerState: this.buildProviderState(input, {}), terminalReason: "error" };
    }

    this.aborter = new AbortController();
    const { model, baseURL, apiKey } = this.opts;

    // First-turn-only forcing — same posture as the legacy force-tool-use
    // middleware. After the model has called the forced tool once, the
    // pin releases so the agent can narrate / chain.
    const forced = input.turnIdx === 0 ? this.opts.forcedToolChoice : undefined;
    const forcedInList = forced && input.tools.some(t => t.name === forced.name);

    const req: ProviderRequest = {
      apiKey,
      baseURL,
      model,
      systemPrompt: this.opts.systemPrompt ?? "You are a helpful assistant.",
      messages: canonicalToChatParam(input.messages, input.pendingRedirect, new Set(input.tools.map(t => t.name))),
      tools: input.tools.map(t => ({
        name: t.name,
        description: t.description ?? "",
        parameters: (t.inputSchema as Record<string, unknown>) ?? {},
      })) as ProviderRequest["tools"],
      temperature: this.opts.temperature ?? 0.7,
      sessionId: this.opts.sessionId,
      signal: this.aborter.signal,
      ...(forcedInList && forced ? { toolChoice: forced } : {}),
    };

    this.inflight = this.runStreamOnce(req, report);
    let result = await this.inflight;

    // Tool-call-in-text fallback: some models emit tool calls as raw JSON
    // inside `content` instead of populating tool_calls. Detect + rewrite.
    applyToolCallTextFallback(result, report, model, new Set(req.tools.map(t => t.name)));

    // Empty-response retry. Some models (qwen2:7b is the canonical
    // offender) accept the `tools` field, run for several seconds, then
    // return ZERO text and ZERO tool calls — silent failure. The
    // existing string-match fallback in OpenAIHttpAdapter only catches
    // the explicit "does not support tools" error string, not the
    // silent case. Without this retry the user sees a blank turn.
    // Mirrors the post-turn empty-response detector + retry from the
    // legacy runStandardAgent loop. No-op for healthy providers (gpt-5,
    // grok, sonnet) — they don't silent-fail on tools.
    const noOutput =
      !this.aborted &&
      !result.firstError &&
      result.assembledText.length === 0 &&
      result.pendingToolCalls.length === 0;
    const hadTools = req.tools.length > 0;
    if (noOutput && hadTools) {
      logger.info(`${model} returned empty with tools — retrying without tools`);
      markNoToolSupport(baseURL, model);
      const retryReq: ProviderRequest = { ...req, tools: [] as unknown as ProviderRequest["tools"] };
      this.inflight = this.runStreamOnce(retryReq, report);
      result = await this.inflight;
    }
    this.inflight = null;

    const { assembledText, pendingToolCalls, firstError, providerStop, usagePromptTokens, usageCompletionTokens } = result;
    let finalizedMessageId: string | null = null;

    // Finalize an assistant CanonicalMessage when there's text OR tool
    // calls. A tool-only turn must still produce an assistant row so
    // the next turn's tool_result can chain to it.
    if (assembledText.length > 0 || pendingToolCalls.length > 0) {
      finalizedMessageId = `cm-${input.opId}-${input.turnIdx}-${Date.now().toString(36)}`;
      const content: { text: string; toolCalls?: typeof pendingToolCalls } = { text: assembledText };
      if (pendingToolCalls.length > 0) content.toolCalls = pendingToolCalls;
      const msg: CanonicalMessage = {
        messageId: finalizedMessageId,
        role: "assistant",
        content,
      };
      report({ kind: "message_finalized", message: msg });
    }

    let terminalReason: "done" | "error" | undefined;
    if (this.aborted) terminalReason = "error";
    else if (firstError) terminalReason = "error";
    else if (pendingToolCalls.length > 0) terminalReason = undefined;
    else terminalReason = "done";

    let providerState = this.buildProviderState(input, {
      finalizedMessageId,
      stopReason: providerStop,
      pendingTools: pendingToolCalls.length,
      model,
      ...(usagePromptTokens !== undefined ? { usageInputTokens: usagePromptTokens } : {}),
      ...(usageCompletionTokens !== undefined ? { usageOutputTokens: usageCompletionTokens } : {}),
    });

    const sizeCheck = this.checkProviderStateSize(providerState);
    if (sizeCheck) {
      report({ kind: "error", code: "provider_state_oversize", message: sizeCheck, retryable: false });
      providerState = {
        adapterName: OPENAI_COMPAT_ADAPTER_NAME,
        adapterVersion: OPENAI_COMPAT_ADAPTER_VERSION,
        providerPayload: { error: "provider_state_oversize" },
      };
      terminalReason = "error";
    }

    return { providerState, terminalReason };
  }

  async abort(reason?: unknown): Promise<void> {
    this.aborted = true;
    try { this.aborter.abort(reason); } catch { /* ignore */ }
    if (this.inflight) { try { await this.inflight; } catch { /* swallow */ } }
  }

  private buildProviderState(input: TurnInput, payload: Record<string, unknown>): ProviderStateEnvelope {
    return {
      adapterName: OPENAI_COMPAT_ADAPTER_NAME,
      adapterVersion: OPENAI_COMPAT_ADAPTER_VERSION,
      providerPayload: { lastTurnIdx: input.turnIdx, ...payload },
    };
  }

  private checkProviderStateSize(env: ProviderStateEnvelope): string | null {
    const size = byteLengthUtf8(JSON.stringify(env));
    return size > PROVIDER_STATE_MAX_BYTES
      ? `provider_state size ${size} bytes exceeds cap ${PROVIDER_STATE_MAX_BYTES}`
      : null;
  }

  private async runStreamOnce(req: ProviderRequest, report: (r: AdapterReport) => void): Promise<StreamOnceResult> {
    const result = await streamOnce(req, report, {
      isAborted: () => this.aborted,
      sessionId: this.opts.sessionId,
    });
    // Mid-stream inject interrupt: streamOnce broke out of the loop and
    // flagged this on the result. Flip the adapter's aborted flag so
    // post-stream handling (terminalReason resolution, empty-response
    // retry guard) treats the turn as aborted, same effect as before
    // the extraction.
    if (result.interruptedByInject) this.aborted = true;
    return result;
  }
}

export function createOpenAICompatAdapter(opts: OpenAICompatAdapterOptions): OpenAICompatAdapter {
  return new OpenAICompatAdapter(opts);
}
