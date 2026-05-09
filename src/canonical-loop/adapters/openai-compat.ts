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
 * after sending tools, we retry once without tools and add the model
 * to `_localNoToolModels` so subsequent turns skip the dead first leg.
 * Catches qwen2's silent-fail pattern (cf. the explicit-error fallback
 * already inside OllamaHttpAdapter). For models that don't have this
 * failure mode (gpt-5, grok, etc.), the condition just never fires.
 */
import { readFileSync } from "node:fs";
import type { Adapter, AdapterReport, TurnInput, TurnResult } from "../adapter-contract.js";
import type { CanonicalMessage, ProviderStateEnvelope } from "../contract-types.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { ProviderRequest } from "../../providers/adapter/types.js";
import { _localNoToolModels } from "../../providers/types.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("canonical-loop.adapters.openai-compat");

export const OPENAI_COMPAT_ADAPTER_NAME = "openai-compat";
export const OPENAI_COMPAT_ADAPTER_VERSION = "1.0.0";
const PROVIDER_STATE_MAX_BYTES = 256 * 1024;

export interface OpenAICompatAdapterOptions {
  /** Required. The model id the OpenAI-compat endpoint expects. */
  model: string;
  /** Required. Full OpenAI-compatible base URL (must include `/v1`). */
  baseURL: string;
  /** Required. Bearer token. Use a placeholder ("ollama") for local
   *  Ollama which doesn't auth. */
  apiKey: string;
  systemPrompt?: string;
  temperature?: number;
  sessionId?: string;
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

    const req: ProviderRequest = {
      apiKey,
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
      _localNoToolModels.add(model);
      const retryReq: ProviderRequest = { ...req, tools: [] as unknown as ProviderRequest["tools"] };
      this.inflight = this.streamOnce(retryReq, report);
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
      // OllamaHttpAdapter extends OpenAIHttpAdapter — same streaming +
      // tool-call accumulation code path used by every OpenAI-compat
      // provider. The class name is historical; the wire shape is what
      // matters and it's universal here.
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
 * the OpenAI-compatible transport. Distinct from `canonicalToTransport`
 * because that helper produces TransportMessage[] with `toolCalls`/
 * `toolCallId` keys (Anthropic shape), while the OpenAI client expects
 * `tool_calls`/`tool_call_id`.
 */
function canonicalToChatParam(
  messages: CanonicalMessage[],
  pendingRedirect: TurnInput["pendingRedirect"],
): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [];
  for (const m of messages) {
    const c = m.content as Record<string, unknown> | string | null | undefined;
    if (m.role === "system") {
      out.push({ role: "system", content: extractText(c) });
      continue;
    }
    if (m.role === "user") {
      const text = extractText(c);
      const images = extractImages(c);
      if (images.length > 0) {
        // Build OpenAI vision content parts: text + base64 image_url(s).
        // Mirrors the legacy buildUserContentWithImages format so existing
        // vision-capable models (gpt-5, qwen-vl, gemini, etc.) parse the
        // request unchanged. File reads happen synchronously here — small
        // cost paid once per turn, no async on the hot path.
        out.push({ role: "user", content: imagesToOpenAIParts(text, images) });
      } else {
        out.push({ role: "user", content: text });
      }
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
      const r = obj.result;
      // Vision-emitting tools (browser screenshot, image_read, etc.)
      // produce a `{ text, images: [{mime, b64}, ...] }` envelope. Emit
      // a tool message with the text summary, then a follow-up user
      // message with image_url multi-part content so the next turn's
      // model actually sees the image. Mirrors the legacy
      // tool-executor.ts pattern at line ~677.
      let resultText: string;
      let imagesPayload: Array<{ mime: string; b64: string }> | null = null;
      if (r && typeof r === "object" && Array.isArray((r as { images?: unknown }).images)) {
        const env = r as { text?: unknown; images: unknown[] };
        resultText = typeof env.text === "string" ? env.text : JSON.stringify(env);
        imagesPayload = env.images.filter((x): x is { mime: string; b64: string } =>
          !!x && typeof x === "object" && typeof (x as { mime?: unknown }).mime === "string" && typeof (x as { b64?: unknown }).b64 === "string",
        );
      } else {
        resultText = typeof r === "string" ? r : JSON.stringify(r ?? null);
      }
      out.push({
        role: "tool",
        tool_call_id: obj.toolCallId ?? "tc-unknown",
        content: resultText,
      });
      if (imagesPayload && imagesPayload.length > 0) {
        const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }> = [
          { type: "text", text: `[Tool returned ${imagesPayload.length} image${imagesPayload.length === 1 ? "" : "s"} — analyze and use them in your reply.]` },
        ];
        for (const img of imagesPayload) {
          parts.push({ type: "image_url", image_url: { url: `data:${img.mime};base64,${img.b64}`, detail: "auto" } });
        }
        out.push({ role: "user", content: parts });
      }
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

interface CanonicalImageRef {
  url: string;
  name: string;
  filePath?: string;
}

function extractImages(c: unknown): CanonicalImageRef[] {
  if (c == null || typeof c !== "object") return [];
  const v = (c as { images?: unknown }).images;
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is CanonicalImageRef =>
    !!x && typeof x === "object" && typeof (x as CanonicalImageRef).name === "string",
  );
}

/**
 * Build OpenAI vision content parts: a text part plus one image_url
 * part per attachment, base64-data-url'd from the on-disk file. Mirrors
 * `buildUserContentWithImages` in run-standard-helpers.ts (legacy path)
 * so the wire shape is identical for any provider that's vision-capable.
 *
 * Adds a trailing text part listing on-disk file paths so the agent can
 * `read`/`bash cp` the original bytes when an app needs the asset on
 * disk (matches legacy behavior — the agent uses these hints to avoid
 * regenerating an image when the user already attached one).
 */
function imagesToOpenAIParts(
  text: string,
  images: CanonicalImageRef[],
): Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }> {
  const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }> = [
    { type: "text", text },
  ];
  const filePathHints: string[] = [];
  for (const img of images) {
    try {
      if (!img.filePath) continue;
      const data = readFileSync(img.filePath);
      const ext = (img.name.split(".").pop() || "png").toLowerCase();
      const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
      const dataUrl = `data:${mime};base64,${data.toString("base64")}`;
      parts.push({ type: "image_url", image_url: { url: dataUrl, detail: "auto" } });
      filePathHints.push(`  - ${img.name} → ${img.filePath}`);
    } catch {
      // Skip unreadable attachments rather than fail the whole turn.
    }
  }
  if (filePathHints.length > 0) {
    parts.push({
      type: "text",
      text:
        `\n\n[Attached file paths on disk — use these if you need to copy the real bytes into the workspace]\n` +
        filePathHints.join("\n") +
        `\n\nTo use an attachment as an app asset: read the file with bash/read, then write it to the target path under workspace/apps/<app>/, or use bash cp. Do NOT generate a new image or download from the web when a user attachment exists — use the file at the path above.`,
    });
  }
  return parts;
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

export function createOpenAICompatAdapter(opts: OpenAICompatAdapterOptions): OpenAICompatAdapter {
  return new OpenAICompatAdapter(opts);
}

/**
 * Resolve the OpenAI-compat baseURL + apiKey for a given canonical
 * provider id. Mirrors the providerURLs map in run-standard.ts so we
 * don't drift while both code paths exist. Once the legacy path is
 * removed, this becomes the only source of truth.
 *
 * Returns null when the provider isn't OpenAI-compat (anthropic/codex
 * use their own adapters) or when required config is missing.
 */
export interface OpenAICompatTarget {
  baseURL: string;
  apiKey: string;
}

export async function resolveOpenAICompatTarget(
  provider: string,
  prepared: { apiKey: string; customBaseURL?: string },
): Promise<OpenAICompatTarget | null> {
  if (provider === "local") {
    const { getRuntimeConfig } = await import("../../config.js");
    return { baseURL: `${getRuntimeConfig().ollamaUrl}/v1`, apiKey: prepared.apiKey || "ollama" };
  }
  if (provider === "ollama-cloud") {
    const { getCloudOllamaCallTarget } = await import("../../ollama-cloud.js");
    return getCloudOllamaCallTarget();  // null when cache cold; caller handles
  }
  if (provider === "xai") return { baseURL: "https://api.x.ai/v1", apiKey: prepared.apiKey };
  if (provider === "openai") return { baseURL: "https://api.openai.com/v1", apiKey: prepared.apiKey };
  if (provider === "gemini") return { baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", apiKey: prepared.apiKey };
  if (provider === "custom") {
    const baseURL = prepared.customBaseURL || "";
    if (!baseURL) return null;
    return { baseURL, apiKey: prepared.apiKey };
  }
  return null;
}
