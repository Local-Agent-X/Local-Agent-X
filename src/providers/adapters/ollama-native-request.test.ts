import { describe, expect, it } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { ProviderRequest } from "../adapter/types.js";
import { buildOllamaChatBody, toOllamaMessages } from "./ollama-native-request.js";
import { canonicalToChatParam, type CanonicalMessage } from "../../canonical-loop/public/test-surface.js";

const PNG = "iVBORw0KGgo=";

function req(over: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    apiKey: "ollama",
    model: "qwen3.6:27b",
    baseURL: "http://127.0.0.1:11434/v1",
    systemPrompt: "You are LAX.",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }],
    ...over,
  } as ProviderRequest;
}

const opts = {
  useTools: true, extraBody: { options: { num_ctx: 172_032 } }, think: true as boolean | string | undefined,
  numPredict: 16_384, includeFormat: true, keepAlive: "30m",
};

describe("toOllamaMessages", () => {
  it("maps system, user, assistant tool calls (arguments as an OBJECT), and tool results with tool_name", () => {
    const history: ChatCompletionMessageParam[] = [
      { role: "user", content: "read a.txt" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{\"path\":\"a.txt\"}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "A" },
    ];
    expect(toOllamaMessages("sys", history)).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "read a.txt" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", function: { name: "read", arguments: { path: "a.txt" } } }] },
      { role: "tool", content: "A", tool_name: "read", tool_call_id: "call_1" },
    ]);
  });

  it("splits content parts into one message per part, images as bare base64 (as Ollama's /v1 does)", () => {
    const parts: ChatCompletionMessageParam = {
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
      ],
    };
    expect(toOllamaMessages("s", [parts]).slice(1)).toEqual([
      { role: "user", content: "what is this?" },
      { role: "user", content: "", images: [PNG] },
    ]);
  });

  it("refuses what /v1 refuses: remote image URLs and non-JSON tool arguments", () => {
    const remote: ChatCompletionMessageParam = { role: "user", content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }] };
    expect(() => toOllamaMessages("s", [remote])).toThrow(/image URLs are not currently supported/);
    const bad: ChatCompletionMessageParam = {
      role: "assistant", content: "", tool_calls: [{ id: "c", type: "function", function: { name: "read", arguments: "{oops" } }],
    };
    expect(() => toOllamaMessages("s", [bad])).toThrow("invalid tool call arguments");
  });

  it("names a tool result after the LAST call with its id", () => {
    const dup: ChatCompletionMessageParam[] = [
      { role: "assistant", content: "", tool_calls: [{ id: "x", type: "function", function: { name: "old", arguments: "{}" } }] },
      { role: "assistant", content: "", tool_calls: [{ id: "x", type: "function", function: { name: "new", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "x", content: "r" },
    ];
    expect(toOllamaMessages("s", dup).at(-1)?.tool_name).toBe("new");
  });
});

describe("EXP-35/36 profile shapes reach the native wire", () => {
  const history: CanonicalMessage[] = [
    { messageId: "u", role: "user", content: { text: "list files" } },
    {
      messageId: "a", role: "assistant",
      content: { text: "I'll list them.", reasoning: "Need glob.", toolCalls: [{ id: "call_9", name: "glob", arguments: "{\"pattern\":\"*\"}" }] },
    },
    { messageId: "t", role: "tool_result", content: { toolCallId: "call_9", result: "a.txt" } },
  ] as unknown as CanonicalMessage[];

  it("text-or-tool-calls + replayReasoning: the calls survive, the plan rides as thinking", () => {
    const rows = toOllamaMessages("s", canonicalToChatParam(history, undefined, new Set(["glob"]), "text-or-tool-calls", true));
    expect(rows[2]).toEqual({
      role: "assistant", content: "", thinking: "Need glob.\n\nI'll list them.",
      tool_calls: [{ id: "call_9", function: { name: "glob", arguments: { pattern: "*" } } }],
    });
  });

  it("replayReasoning off (the measured default): no history row carries thinking", () => {
    const rows = toOllamaMessages("s", canonicalToChatParam(history, undefined, new Set(["glob"]), "text-or-tool-calls", false));
    expect(rows.some((r) => "thinking" in r)).toBe(false);
    expect(rows[2]).toMatchObject({ role: "assistant", content: "" });
  });
});

describe("buildOllamaChatBody", () => {
  it("carries num_ctx from the sizing seam, sampling, num_predict, think, keep_alive, tools, stream", () => {
    const body = buildOllamaChatBody(req({ temperature: 0.6, topP: 0.95, topK: 20, minP: 0, presencePenalty: 0, repeatPenalty: 1 }), opts);
    expect(body).toMatchObject({
      model: "qwen3.6:27b",
      stream: true,
      keep_alive: "30m",
      think: true,
      tools: [{ type: "function", function: { name: "read", description: "Read a file" } }],
      options: {
        num_ctx: 172_032, temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 0,
        repeat_penalty: 1, num_predict: 16_384,
      },
    });
    expect(body).not.toHaveProperty("format");
  });

  it("sends the JSON schema as format for a structured-output request", () => {
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    const body = buildOllamaChatBody(req({ responseFormat: { type: "json_schema", name: "verdict", schema } }), opts);
    expect(body.format).toEqual(schema);
  });

  it("omits what it was not given: no num_ctx without a decision, no think, no tools, default temperature", () => {
    const body = buildOllamaChatBody(req(), { ...opts, extraBody: {}, think: undefined, useTools: false, numPredict: undefined });
    expect(body).not.toHaveProperty("think");
    expect(body).not.toHaveProperty("tools");
    expect(body.options).toEqual({ temperature: 0.7 });
  });

  it("sends think:false for thinking off", () => {
    expect(buildOllamaChatBody(req(), { ...opts, think: false }).think).toBe(false);
  });
});
