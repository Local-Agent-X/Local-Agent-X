/**
 * ProviderRequest -> Ollama native /api/chat body. Pure.
 *
 * The history rebuild produces OpenAI-shape messages
 * (canonical-to-chat-param.ts); this converts them the way Ollama's own /v1
 * shim does (openai/openai.go FromChatRequest, ollama@16b4376a lines
 * 619-707), so the model's template renders the same prompt on either path
 * and the runtime's prefix cache sees the same tokens:
 *   - a content-part array becomes one message per part (a text part is a
 *     message, an image part is a message carrying `images`), tool calls on
 *     the last of them;
 *   - tool-call arguments go as an OBJECT, parsed from the JSON string
 *     (FromCompletionToolCall, lines 841-854 — invalid JSON is the same
 *     "invalid tool call arguments" /v1 answers with a 400);
 *   - a tool message gets `tool_name` from the call it answers, last match
 *     wins (nameFromToolCallID, lines 795-807);
 *   - an assistant row's `reasoning` rides as `thinking` (model-profile
 *     replayReasoning; api.Message.Thinking, api/types.go line 201);
 *   - image data URLs are sent as bare base64 (decodeImageURL, lines
 *     810-839); a remote http(s) image URL is refused as /v1 refuses it.
 * Body fields are api/types.go ChatRequest (lines 133-179): stream, format,
 * keep_alive, tools, options (Options/Runner, lines 568-597), think.
 */
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { ProviderRequest } from "../adapter/types.js";
import { toOpenAITools } from "../shared/tool-shape.js";

export interface OllamaMessage {
  role: string;
  content: string;
  thinking?: string;
  images?: string[];
  tool_calls?: Array<{ id?: string; function: { name: string; arguments: Record<string, unknown> } }>;
  tool_name?: string;
  tool_call_id?: string;
}

type Part = { type?: string; text?: unknown; image_url?: unknown };
type OpenAIToolCall = { id?: string; function?: { name?: string; arguments?: string } };
type LooseMessage = {
  role: string;
  content?: unknown;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
  reasoning?: unknown;
};

const IMAGE_PREFIXES = ["data:;base64,", ...["jpeg", "jpg", "png", "webp"].map((t) => `data:image/${t};base64,`)];

function imageBase64(url: string): string {
  if (/^https?:\/\//i.test(url)) throw new Error("image URLs are not currently supported, please use base64 encoded data instead");
  const prefix = IMAGE_PREFIXES.find((p) => url.startsWith(p));
  if (!prefix) throw new Error("invalid image input");
  return url.slice(prefix.length);
}

function toolCalls(calls: OpenAIToolCall[] | undefined): OllamaMessage["tool_calls"] {
  if (!calls || calls.length === 0) return undefined;
  return calls.map((tc) => {
    let args: unknown;
    try { args = JSON.parse(tc.function?.arguments ?? ""); } catch { args = null; }
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("invalid tool call arguments");
    return {
      ...(tc.id ? { id: tc.id } : {}),
      function: { name: tc.function?.name ?? "", arguments: args as Record<string, unknown> },
    };
  });
}

function toolNameFor(messages: readonly LooseMessage[], id: string | undefined): string {
  if (!id) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const hit = messages[i].tool_calls?.find((tc) => tc.id === id);
    if (hit) return hit.function?.name ?? "";
  }
  return "";
}

export function toOllamaMessages(systemPrompt: string, messages: readonly ChatCompletionMessageParam[]): OllamaMessage[] {
  const all: LooseMessage[] = [{ role: "system", content: systemPrompt }, ...(messages as unknown as LooseMessage[])];
  const out: OllamaMessage[] = [];
  for (const msg of all) {
    const role = msg.role.toLowerCase();
    const toolName = role === "tool" ? msg.name || toolNameFor(all, msg.tool_call_id) : "";
    const thinking = typeof msg.reasoning === "string" && msg.reasoning ? msg.reasoning : undefined;
    const calls = toolCalls(msg.tool_calls);
    const extras = {
      ...(thinking ? { thinking } : {}),
      ...(calls ? { tool_calls: calls } : {}),
      ...(toolName ? { tool_name: toolName } : {}),
      ...(msg.tool_call_id ? { tool_call_id: msg.tool_call_id } : {}),
    };
    if (Array.isArray(msg.content)) {
      const start = out.length;
      for (const part of msg.content as Part[]) {
        if (part.type === "text" && typeof part.text === "string") {
          out.push({ role, content: part.text });
        } else if (part.type === "image_url") {
          const url = typeof part.image_url === "string" ? part.image_url : (part.image_url as { url?: unknown })?.url;
          if (typeof url !== "string") throw new Error("invalid message format");
          out.push({ role, content: "", images: [imageBase64(url)] });
        } else {
          throw new Error("invalid message format");
        }
      }
      if (calls && out.length > start) Object.assign(out[out.length - 1], extras);
      continue;
    }
    out.push({ role, content: typeof msg.content === "string" ? msg.content : "", ...extras });
  }
  return out;
}

export interface OllamaChatBodyOpts {
  useTools: boolean;
  /** From the context-sizing decision via the probe's chatExtraBody. */
  extraBody: Record<string, unknown>;
  /** false = thinking off; a level string for a dial-able model; true = on. */
  think: boolean | string | undefined;
  numPredict: number | undefined;
  includeFormat: boolean;
  keepAlive: string;
}

export function buildOllamaChatBody(req: ProviderRequest, opts: OllamaChatBodyOpts): Record<string, unknown> {
  const extraOptions = (opts.extraBody.options ?? {}) as Record<string, unknown>;
  const options: Record<string, unknown> = {
    ...extraOptions,
    temperature: req.temperature ?? 0.7,
    ...(req.topP !== undefined ? { top_p: req.topP } : {}),
    ...(req.topK !== undefined ? { top_k: req.topK } : {}),
    ...(req.minP !== undefined ? { min_p: req.minP } : {}),
    ...(req.presencePenalty !== undefined ? { presence_penalty: req.presencePenalty } : {}),
    ...(req.repeatPenalty !== undefined ? { repeat_penalty: req.repeatPenalty } : {}),
    ...(opts.numPredict !== undefined ? { num_predict: opts.numPredict } : {}),
  };
  const { options: _options, ...extraTop } = opts.extraBody;
  return {
    model: req.model,
    messages: toOllamaMessages(req.systemPrompt, req.messages),
    ...(opts.useTools && req.tools.length > 0 ? { tools: toOpenAITools(req.tools) } : {}),
    stream: true,
    keep_alive: opts.keepAlive,
    ...(opts.think !== undefined ? { think: opts.think } : {}),
    ...(opts.includeFormat && req.responseFormat ? { format: req.responseFormat.schema } : {}),
    ...extraTop,
    options,
  };
}
