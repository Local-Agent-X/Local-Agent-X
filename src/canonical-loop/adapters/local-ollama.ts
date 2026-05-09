/**
 * Local Ollama adapter — v1 implementation of the canonical adapter
 * contract for the `local` provider (Ollama-served chat models like
 * qwen, llama, etc.).
 *
 * Structurally mirrors codex.ts: convert canonical messages → OpenAI-
 * compatible ChatCompletionMessageParam[], hand off to the existing
 * `OllamaHttpAdapter` (which already streams + handles tool calls +
 * gracefully falls back when a model rejects the `tools` field), and
 * report stream/tool/done events back through the canonical contract.
 *
 * Stateless: Ollama doesn't have an analogue of Codex's
 * `previousResponseId`. Each turn re-sends full history. provider_state
 * is minimal — just `lastTurnIdx`, model, and usage.
 */
import type { Adapter, AdapterReport, TurnInput, TurnResult } from "../adapter-contract.js";
import type { CanonicalMessage, ProviderStateEnvelope } from "../contract-types.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { ProviderRequest } from "../../providers/adapter/types.js";
import { _localNoToolModels } from "../../providers/types.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("canonical-loop.adapters.local-ollama");

export const LOCAL_OLLAMA_ADAPTER_NAME = "local-ollama";
export const LOCAL_OLLAMA_ADAPTER_VERSION = "1.0.0";
const PROVIDER_STATE_MAX_BYTES = 256 * 1024;

export interface LocalOllamaAdapterOptions {
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  /** Override the Ollama base URL. Defaults to `${runtimeConfig.ollamaUrl}/v1`.
   *  Set to `<cloudUrl>/v1` to route through Ollama Cloud. */
  baseURL?: string;
  /** Bearer token. Defaults to a placeholder for local Ollama (no auth).
   *  Set to the cloud API key when routing through Ollama Cloud. */
  apiKey?: string;
  sessionId?: string;
}

export class LocalOllamaAdapter implements Adapter {
  readonly name = LOCAL_OLLAMA_ADAPTER_NAME;
  readonly version = LOCAL_OLLAMA_ADAPTER_VERSION;

  private aborted = false;
  private aborter: AbortController = new AbortController();
  private inflight: Promise<StreamOnceResult> | null = null;

  constructor(private readonly opts: LocalOllamaAdapterOptions = {}) {}

  async runTurn(input: TurnInput, report: (r: AdapterReport) => void): Promise<TurnResult> {
    if (this.aborted) {
      report({ kind: "error", code: "aborted", message: "adapter aborted before runTurn", retryable: false });
      return { providerState: this.buildProviderState(input, {}), terminalReason: "error" };
    }

    this.aborter = new AbortController();
    const model = this.opts.model ?? "qwen3:14b";

    let baseURL = this.opts.baseURL;
    if (!baseURL) {
      const { getRuntimeConfig } = await import("../../config.js");
      baseURL = `${getRuntimeConfig().ollamaUrl}/v1`;
    }

    const req: ProviderRequest = {
      apiKey: this.opts.apiKey ?? "ollama",
      baseURL,
      model,
      systemPrompt: this.opts.systemPrompt ?? "You are a helpful assistant.",
      messages: canonicalToChatParam(input.messages, input.pendingRedirect),
      tools: input.tools.map(t => ({
        name: t.name,
        description: t.description ?? "",
        parameters: (t.inputSchema as Record<string, unknown>) ?? {},
      })) as ProviderRequest["tools"],
      temperature: this.opts.temperature ?? 0.7,
      sessionId: this.opts.sessionId,
      signal: this.aborter.signal,
    };

    this.inflight = this.streamOnce(req, report);
    let result = await this.inflight;

    // Empty-response retry. Some local models (qwen2:7b is the canonical
    // offender) accept the `tools` field, run for ~10s, then return
    // ZERO text and ZERO tool calls — silent failure. The existing
    // `_localNoToolModels` fallback at openai-http only catches the
    // explicit "does not support tools" error string, not the silent
    // case. Without this retry the user sees a 14-second blank turn
    // and has no idea anything went wrong. Mirrors the post-turn
    // empty-response detector + retry from the legacy
    // `runStandardAgent` loop, kept inside the adapter so it doesn't
    // leak into the canonical-loop architecture.
    const noOutput =
      !this.aborted &&
      !result.firstError &&
      result.assembledText.length === 0 &&
      result.pendingToolCalls.length === 0;
    const hadTools = req.tools.length > 0;
    if (noOutput && hadTools) {
      logger.info(`${model} returned empty with tools — retrying without tools`);
      _localNoToolModels.add(model);
      const retryReq: ProviderRequest = { ...req, tools: [] as unknown as ProviderRequest["tools"] };
      this.inflight = this.streamOnce(retryReq, report);
      result = await this.inflight;
    }
    this.inflight = null;

    const { assembledText, pendingToolCalls, firstError, providerStop, usagePromptTokens, usageCompletionTokens } = result;
    let finalizedMessageId: string | null = null;

    // Finalize an assistant CanonicalMessage when there's text OR tool
    // calls (mirroring codex.ts). A tool-only turn must still produce an
    // assistant row so the next turn's tool_result can chain to it.
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
        adapterName: LOCAL_OLLAMA_ADAPTER_NAME,
        adapterVersion: LOCAL_OLLAMA_ADAPTER_VERSION,
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
      adapterName: LOCAL_OLLAMA_ADAPTER_NAME,
      adapterVersion: LOCAL_OLLAMA_ADAPTER_VERSION,
      providerPayload: { lastTurnIdx: input.turnIdx, ...payload },
    };
  }

  private checkProviderStateSize(env: ProviderStateEnvelope): string | null {
    const size = byteLengthUtf8(JSON.stringify(env));
    return size > PROVIDER_STATE_MAX_BYTES
      ? `provider_state size ${size} bytes exceeds cap ${PROVIDER_STATE_MAX_BYTES}`
      : null;
  }

  private async streamOnce(req: ProviderRequest, report: (r: AdapterReport) => void): Promise<StreamOnceResult> {
    const out: StreamOnceResult = {
      assembledText: "",
      pendingToolCalls: [],
      firstError: null,
      providerStop: undefined,
      usagePromptTokens: undefined,
      usageCompletionTokens: undefined,
    };
    try {
      const { ollamaHttpAdapter } = await import("../../providers/adapters/ollama-http.js");
      for await (const ev of ollamaHttpAdapter.stream(req)) {
        if (this.aborted) break;
        if (ev.type === "text") {
          if (!ev.delta) continue;
          out.assembledText += ev.delta;
          report({ kind: "stream_chunk", body: { delta: ev.delta } });
          continue;
        }
        if (ev.type === "tool_call") {
          out.pendingToolCalls.push({ id: ev.id, name: ev.name, arguments: ev.arguments });
          report({ kind: "tool_call_requested", call: { toolCallId: ev.id, tool: ev.name, args: parseArgs(ev.arguments) } });
          continue;
        }
        if (ev.type === "usage") {
          out.usagePromptTokens = ev.promptTokens;
          out.usageCompletionTokens = ev.completionTokens;
          continue;
        }
        if (ev.type === "error") {
          const message = ev.message ?? "transport error";
          if (!out.firstError) out.firstError = { code: "transport_error", message };
          report({ kind: "error", code: "transport_error", message, retryable: false });
          continue;
        }
        if (ev.type === "done") {
          out.providerStop = ev.stopReason;
          continue;
        }
      }
    } catch (e) {
      const message = (e as Error).message ?? String(e);
      if (!out.firstError) out.firstError = { code: "transport_exception", message };
      report({ kind: "error", code: "transport_exception", message, retryable: false });
    }
    return out;
  }
}

interface StreamOnceResult {
  assembledText: string;
  pendingToolCalls: Array<{ id: string; name: string; arguments: string }>;
  firstError: { code: string; message: string } | null;
  providerStop: string | undefined;
  usagePromptTokens: number | undefined;
  usageCompletionTokens: number | undefined;
}

// ── helpers ──────────────────────────────────────────────────────────────

/**
 * Convert canonical messages → OpenAI ChatCompletionMessageParam[] for
 * the OllamaHttpAdapter (which inherits OpenAI-compat shape). Distinct
 * from `canonicalToTransport` because that helper produces
 * `TransportMessage[]` with `toolCalls`/`toolCallId` keys, while the
 * OpenAI client expects `tool_calls`/`tool_call_id`.
 */
function canonicalToChatParam(
  messages: CanonicalMessage[],
  pendingRedirect: TurnInput["pendingRedirect"],
): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [];
  for (const m of messages) {
    const c = m.content as Record<string, unknown> | string | null | undefined;
    if (m.role === "system" || m.role === "user") {
      out.push({ role: m.role, content: extractText(c) });
      continue;
    }
    if (m.role === "assistant") {
      const obj = (c ?? {}) as { text?: unknown; toolCalls?: unknown };
      const tc = Array.isArray(obj.toolCalls)
        ? (obj.toolCalls as Array<{ id: string; name: string; arguments: string }>)
        : undefined;
      const text = extractText(c);
      if (tc && tc.length > 0) {
        out.push({
          role: "assistant",
          content: text,
          tool_calls: tc.map(t => ({
            id: t.id,
            type: "function",
            function: { name: t.name, arguments: t.arguments },
          })),
        });
      } else {
        out.push({ role: "assistant", content: text });
      }
      continue;
    }
    if (m.role === "tool_result") {
      const obj = (c ?? {}) as { toolCallId?: string; result?: unknown };
      const content = typeof obj.result === "string"
        ? obj.result
        : JSON.stringify(obj.result ?? null);
      out.push({
        role: "tool",
        tool_call_id: obj.toolCallId ?? "tc-unknown",
        content,
      });
      continue;
    }
    if (m.role === "control") {
      const text = extractText(c);
      if (text) out.push({ role: "user", content: `[CONTROL] ${text}` });
      continue;
    }
  }
  if (pendingRedirect) {
    out.push({ role: "user", content: `[REDIRECT] ${pendingRedirect.text}` });
  }
  return out;
}

function extractText(c: unknown): string {
  if (c == null) return "";
  if (typeof c === "string") return c;
  if (typeof c === "object" && "text" in (c as Record<string, unknown>)) {
    const v = (c as { text?: unknown }).text;
    return typeof v === "string" ? v : "";
  }
  return "";
}

function parseArgs(raw: string): unknown {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return { _raw: raw }; }
}

function byteLengthUtf8(s: string): number {
  let len = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x80) len += 1;
    else if (code < 0x800) len += 2;
    else if (code >= 0xd800 && code <= 0xdbff) { len += 4; i++; }
    else len += 3;
  }
  return len;
}

export function createLocalOllamaAdapter(opts: LocalOllamaAdapterOptions = {}): LocalOllamaAdapter {
  return new LocalOllamaAdapter(opts);
}
