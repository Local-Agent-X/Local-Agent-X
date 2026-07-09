// Gemini native transport — owns the HTTP/SSE call to Google's
// generateContent API. Structurally the Gemini analog of codex-transport.ts /
// anthropic-transport.ts: it takes the shared TransportMessage[]/TransportTool[]
// envelope and yields TransportEvents the adapter consumes.
//
// Why native, not the OpenAI-compat endpoint: Gemini's compat shim
// nondeterministically returns empty STOP completions on tool-laden requests
// (a known Google bug — no client-side fix works). The native generateContent
// API is Google's first-class function-calling surface and doesn't have it.
//
// Wire shape (v1beta):
//   POST /v1beta/models/{model}:streamGenerateContent?alt=sse&key={key}
//   { systemInstruction, contents[], tools:[{functionDeclarations}], toolConfig,
//     generationConfig:{temperature, thinkingConfig} }
//   SSE frames: each `data:` line is a partial GenerateContentResponse whose
//   candidates[0].content.parts[] carry {text} | {functionCall} | {thought,text}.

import type { TransportMessage, TransportTool, TransportEvent } from "./anthropic/types.js";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export interface GeminiNativeRequest {
  model: string;
  apiKey: string;
  systemPrompt: string;
  messages: TransportMessage[];
  tools: TransportTool[];
  signal: AbortSignal;
  temperature?: number;
  /** Maps the canonical reasoning_effort to Gemini's thinking budget. */
  thinking?: boolean;
  forcedToolChoice?: { type: "tool"; name: string };
}

// Gemini streams a "thought" part during reasoning; the adapter maps this to a
// heartbeat (keeps the idle watchdog alive) rather than rendering it. Distinct
// from the shared TransportEvent so the shared union stays provider-agnostic.
export type GeminiTransportEvent = TransportEvent | { type: "thinking"; delta?: string };

export interface GeminiNativeTransport {
  stream(req: GeminiNativeRequest): AsyncIterable<GeminiTransportEvent>;
}

// ── Schema → Gemini OpenAPI subset ────────────────────────────────────────
// Gemini's functionDeclarations.parameters is an OpenAPI Schema, a SUBSET of
// JSON Schema. Unsupported keywords cause a 400. Map a copy to the subset:
// drop unknown keywords, repair property-less objects / items-less arrays.
const SCHEMA_KEYS = new Set([
  "type", "description", "nullable", "enum", "properties", "required",
  "items", "minItems", "maxItems", "minimum", "maximum", "format",
]);
const OK_FORMATS = new Set(["enum", "date-time"]);

function toGeminiSchema(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return { type: "string" };
  const node = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (!SCHEMA_KEYS.has(k)) continue;
    if (k === "format") { if (typeof v === "string" && OK_FORMATS.has(v)) out.format = v; continue; }
    out[k] = v;
  }
  if (out.type === "object" || out.properties) {
    out.type = "object";
    const props = (node.properties && typeof node.properties === "object") ? node.properties as Record<string, unknown> : {};
    const clean: Record<string, unknown> = {};
    for (const [name, sub] of Object.entries(props)) clean[name] = toGeminiSchema(sub);
    out.properties = clean;
    if (Array.isArray(node.required)) {
      const req = (node.required as unknown[]).filter(r => typeof r === "string" && r in clean);
      if (req.length > 0) out.required = req; else delete out.required;
    }
  }
  if (out.type === "array" || out.items) { out.type = "array"; out.items = toGeminiSchema(node.items ?? { type: "string" }); }
  if (!out.type) out.type = "string";
  return out;
}

// ── Message → Gemini contents ─────────────────────────────────────────────
type Part = Record<string, unknown>;
type Content = { role: "user" | "model"; parts: Part[] };

function dataUrlToInline(url: string): Part | null {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
  if (!m) return null;
  return { inlineData: { mimeType: m[1], data: m[2] } };
}

export function toGeminiContents(messages: TransportMessage[]): Content[] {
  // tool_result rows carry only toolCallId; Gemini's functionResponse needs the
  // function NAME. Resolve it from the assistant tool_calls earlier in history.
  const idToName = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls) for (const tc of m.toolCalls) idToName.set(tc.id, tc.name);
  }

  const contents: Content[] = [];
  for (const m of messages) {
    if (m.role === "system") continue; // → systemInstruction
    if (m.role === "user") {
      const parts: Part[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const img of m.images ?? []) { const p = dataUrlToInline(img.url); if (p) parts.push(p); }
      if (parts.length === 0) parts.push({ text: "" });
      contents.push({ role: "user", parts });
      continue;
    }
    if (m.role === "assistant") {
      const parts: Part[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.toolCalls ?? []) {
        let args: unknown = {};
        try { args = tc.arguments ? JSON.parse(tc.arguments) : {}; } catch { args = {}; }
        parts.push({ functionCall: { name: tc.name, args } });
      }
      if (parts.length === 0) parts.push({ text: "" });
      contents.push({ role: "model", parts });
      continue;
    }
    if (m.role === "tool") {
      const name = idToName.get(m.toolCallId ?? "") ?? m.toolCallId ?? "tool";
      let response: unknown;
      try { response = JSON.parse(m.content); } catch { response = { result: m.content }; }
      if (!response || typeof response !== "object") response = { result: response };
      contents.push({ role: "user", parts: [{ functionResponse: { name, response } }] });
      continue;
    }
  }
  return contents;
}

function toFunctionDeclarations(tools: TransportTool[]): Part[] {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    parameters: toGeminiSchema(t.parameters),
  }));
}

export function buildGeminiBody(req: GeminiNativeRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    contents: toGeminiContents(req.messages),
    generationConfig: {
      temperature: req.temperature ?? 0.7,
      ...(req.thinking ? { thinkingConfig: { includeThoughts: true } } : {}),
    },
  };
  if (req.systemPrompt) body.systemInstruction = { parts: [{ text: req.systemPrompt }] };
  if (req.tools.length > 0) {
    body.tools = [{ functionDeclarations: toFunctionDeclarations(req.tools) }];
    body.toolConfig = req.forcedToolChoice
      ? { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [req.forcedToolChoice.name] } }
      : { functionCallingConfig: { mode: "AUTO" } };
  }
  return body;
}

let synthId = 0;

export function defaultGeminiNativeTransport(): GeminiNativeTransport {
  return {
    async *stream(req: GeminiNativeRequest): AsyncIterable<GeminiTransportEvent> {
      const url = `${GEMINI_BASE}/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(req.apiKey)}`;
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(buildGeminiBody(req)),
          signal: req.signal,
        });
      } catch (e) {
        yield { type: "error", code: "transport_exception", message: (e as Error).message, retryable: true };
        yield { type: "done" };
        return;
      }
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        yield { type: "error", code: `http_${res.status}`, message: text.slice(0, 500) || res.statusText, retryable: res.status >= 500 || res.status === 429 };
        yield { type: "done" };
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let stopReason: string | undefined;
      let usage: { inputTokens: number; outputTokens: number } | undefined;

      const handleFrame = function* (json: string): Generator<GeminiTransportEvent> {
        let obj: { candidates?: Array<{ content?: { parts?: Part[] }; finishReason?: string }>; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
        try { obj = JSON.parse(json); } catch { return; }
        const cand = obj.candidates?.[0];
        for (const part of cand?.content?.parts ?? []) {
          if ((part as { thought?: boolean }).thought) { const tt = (part as { text?: unknown }).text; yield { type: "thinking", delta: typeof tt === "string" ? tt : undefined }; continue; }
          if (typeof (part as { text?: unknown }).text === "string") {
            const t = (part as { text: string }).text;
            if (t.length > 0) yield { type: "text", delta: t };
            continue;
          }
          const fc = (part as { functionCall?: { name: string; args?: unknown } }).functionCall;
          if (fc) {
            synthId = (synthId + 1) % 1_000_000;
            yield { type: "tool_call", id: `gem_${Date.now().toString(36)}_${synthId.toString(36)}`, name: fc.name, arguments: JSON.stringify(fc.args ?? {}) };
          }
        }
        if (cand?.finishReason) stopReason = cand.finishReason;
        const um = obj.usageMetadata;
        if (um) usage = { inputTokens: um.promptTokenCount ?? 0, outputTokens: um.candidatesTokenCount ?? 0 };
      };

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          // Gemini SSE uses CRLF line endings; strip CR so frame splitting on
          // the blank-line boundary ("\n\n") works regardless of \r\n vs \n.
          buf += decoder.decode(value, { stream: true }).replace(/\r/g, "");
          // SSE frames are separated by a blank line; each carries one `data:` line.
          let nl: number;
          while ((nl = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, nl);
            buf = buf.slice(nl + 2);
            const line = frame.split("\n").find(l => l.startsWith("data:"));
            if (line) yield* handleFrame(line.slice(5).trim());
          }
        }
      } catch (e) {
        yield { type: "error", code: "stream_exception", message: (e as Error).message, retryable: true };
      }
      yield { type: "done", stopReason, ...(usage ? { usage } : {}) };
    },
  };
}
