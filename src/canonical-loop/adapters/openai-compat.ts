/**
 * OpenAI-compatible canonical adapter.
 *
 * Covers every provider whose wire protocol is OpenAI Chat Completions:
 * Ollama (local + Turbo cloud), xAI Grok, OpenAI direct, Together /
 * OpenRouter / any custom OpenAI-shape endpoint. The differences between
 * them are baseURL + apiKey + model name. That's it. So one adapter handles
 * all of them — caller passes the resolved `baseURL` + `apiKey` and we
 * stream, accumulate, finalize. (Gemini does NOT ride this adapter — its
 * compat endpoint empties on tool-laden requests; it uses gemini-native.ts.)
 *
 * Mirrors `codex.ts` shape: convert canonical messages →
 * ChatCompletionMessageParam[], hand off to `OpenAIHttpAdapter` (the
 * same code path used by the legacy `runStandardAgent`), and report
 * stream/tool/done events back through the canonical contract.
 *
 * Stateless: no Codex-style `previousResponseId` chaining. Each turn
 * re-sends full history. provider_state is just `lastTurnIdx`, model,
 * and usage.
 *
 * Empty-response retry: if a turn produces zero text + zero tool calls
 * after sending tools, we retry once without tools so the turn isn't blank.
 * The PERMANENT no-tool latch (markNoToolSupport) only applies to loopback
 * endpoints — a local model that empties on tools genuinely can't do them
 * (qwen2's silent-fail pattern). A cloud frontier model (Gemini compat, grok,
 * gpt-5) that empties is transient and must NOT be latched, or it narrates
 * every later turn with no tools. See shouldLatchNoToolSupport.
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
import { proseLooksLikeToolCall } from "./tool-call-text-extractor.js";
import { classifyModelStop } from "./model-stop.js";

export { OPENAI_COMPAT_ADAPTER_NAME, OPENAI_COMPAT_ADAPTER_VERSION } from "./openai-compat/types.js";
export type { OpenAICompatAdapterOptions, OpenAICompatTarget } from "./openai-compat/types.js";
export { resolveOpenAICompatTarget } from "./openai-compat/resolve-target.js";

const logger = createLogger("canonical-loop.adapters.openai-compat");

/**
 * Whether an empty-with-tools turn should PERMANENTLY latch the model to
 * no-tool mode (via markNoToolSupport) vs just retry-without-tools for this
 * one turn.
 *
 * Latch ONLY for loopback/local endpoints. The latch exists for genuinely
 * tool-incapable local models (qwen2:7b on local Ollama): there, an empty
 * response really does mean "this model can't do tools," and latching saves a
 * dead first leg on every later turn. For CLOUD frontier providers (Gemini's
 * compat endpoint, xAI, OpenAI, Ollama Turbo) an empty completion is a
 * transient/payload issue, NOT proof of no tool support — Gemini returned
 * empty with 98 tools attached, the latch flipped it to chat-only for the
 * whole process, and it then narrated every later turn without ever calling a
 * tool. So cloud endpoints get the per-turn retry but never the permanent kill.
 */
export function shouldLatchNoToolSupport(baseURL: string | undefined): boolean {
  if (!baseURL) return false;
  let host: string;
  try {
    host = new URL(baseURL).hostname.toLowerCase();
  } catch {
    return false;
  }
  // Strip IPv6 brackets if URL parsing left them.
  host = host.replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
}

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
    // Layer 1: when no specific tool is pinned, agents still force *some*
    // tool call on turn 0 so weak models can't open with a prose-narrated
    // tool call. Turn-0 only; releases afterward. No-op without tools.
    const requireTool =
      input.turnIdx === 0 &&
      !forcedInList &&
      this.opts.requireToolOnFirstTurn === true &&
      input.tools.length > 0;

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
      ...(forcedInList && forced
        ? { toolChoice: forced }
        : requireTool
          ? { toolChoice: "required" as const }
          : {}),
    };

    this.inflight = this.runStreamOnce(req, report);
    let result = await this.inflight;

    // Tool-call-in-text fallback: some models emit tool calls as raw JSON
    // inside `content` instead of populating tool_calls. Detect + rewrite.
    const toolNameSet = new Set(req.tools.map(t => t.name));
    applyToolCallTextFallback(result, report, model, toolNameSet);

    // Layer 2: prose-narration recovery. If extraction couldn't salvage a
    // call but the text READS like a narrated tool call (e.g. Grok's "run
    // tool bash with command is …" with no value marker the extractor could
    // anchor on), inject a wire-format-error nudge and retry the turn ONCE
    // with tool_choice forced. Mirrors the Anthropic adapter's
    // `<wire-format-error: … emitted as text — retry…>` recovery. Mutually
    // exclusive with the empty-response retry below (that fires on zero
    // text; this fires on prose). No-op for healthy providers.
    const narratedToolCall =
      !this.aborted &&
      !result.interruptedByInject &&
      !result.firstError &&
      result.pendingToolCalls.length === 0 &&
      req.tools.length > 0 &&
      proseLooksLikeToolCall(result.assembledText, toolNameSet);
    if (narratedToolCall) {
      logger.info(`${model} narrated a tool call as prose — nudging for a real tool_call and retrying once`);
      const nudgeReq: ProviderRequest = {
        ...req,
        messages: [
          ...req.messages,
          { role: "assistant", content: result.assembledText },
          {
            role: "user",
            content:
              "<wire-format-error: your previous reply described a tool call in prose but did not emit one — it was NOT executed and produced no result. Reissue it now as a real structured tool call (function call), not as text.>",
          },
        ],
        toolChoice: "required",
      };
      this.inflight = this.runStreamOnce(nudgeReq, report);
      result = await this.inflight;
      applyToolCallTextFallback(result, report, model, toolNameSet);
    }

    // Empty-response retry. Some models (qwen2:7b is the canonical offender)
    // accept the `tools` field, run for several seconds, then return ZERO text
    // and ZERO tool calls — a silent failure. Retry once without tools so the
    // turn isn't blank. The PERMANENT no-tool latch only applies to loopback
    // endpoints, where an empty really does mean the local model can't do
    // tools; a cloud frontier model (xAI, OpenAI) that empties once is
    // transient and must not be latched off for the whole process. No-op for
    // healthy providers (gpt-5, grok, sonnet) — they don't silent-fail.
    const noOutput =
      !this.aborted &&
      !result.interruptedByInject &&
      !result.firstError &&
      result.assembledText.length === 0 &&
      result.pendingToolCalls.length === 0;
    if (noOutput && req.tools.length > 0) {
      const latch = shouldLatchNoToolSupport(baseURL);
      logger.info(`${model} returned empty with tools — retrying without tools${latch ? " (latched: local endpoint)" : " (this turn only: cloud endpoint)"}`);
      if (latch) markNoToolSupport(baseURL, model);
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
    else if (result.interruptedByInject) terminalReason = "done";
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

    // Real terminal signal — the provider's finish_reason, normalized. See
    // model-stop.ts; decide-outcome trusts it over the shape inference.
    return { providerState, terminalReason, modelStop: classifyModelStop(providerStop) };
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
    // flagged this on the result. The flag flows through to the caller via
    // result.interruptedByInject — runTurn uses it to skip the empty-
    // response retry and pick terminalReason='done' (not 'error') so the
    // worker continues into the next iteration where drainInjectsIntoTurn
    // surfaces the user's text. DO NOT set this.aborted here — that flag
    // is sticky across runTurn calls (see line 64) and would short-circuit
    // the next iteration before the inject could be drained, killing the
    // stream and ignoring the user's message. Observed on xAI Grok: HTTP
    // streaming surfaces events fast enough that this code path fires
    // mid-stream reliably; Anthropic/Codex CLI transports buffer enough
    // that they rarely hit it, which is why the bug only showed up there.
    return result;
  }
}

export function createOpenAICompatAdapter(opts: OpenAICompatAdapterOptions): OpenAICompatAdapter {
  return new OpenAICompatAdapter(opts);
}
