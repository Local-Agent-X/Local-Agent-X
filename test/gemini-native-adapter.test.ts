import { describe, expect, it, vi, afterEach } from "vitest";
import { toGeminiContents, buildGeminiBody, defaultGeminiNativeTransport, type GeminiNativeRequest, type GeminiNativeTransport, type GeminiTransportEvent } from "../src/canonical-loop/adapters/gemini-native-transport.js";
import { createGeminiNativeAdapter } from "../src/canonical-loop/adapters/gemini-native.js";
import type { TransportMessage } from "../src/canonical-loop/adapters/anthropic/types.js";
import type { AdapterReport, TurnInput } from "../src/canonical-loop/adapter-contract.js";

describe("toGeminiContents — canonical → Gemini wire", () => {
  it("maps roles and resolves functionResponse name from prior tool_calls", () => {
    const msgs: TransportMessage[] = [
      { role: "system", content: "be helpful" },
      { role: "user", content: "open x.com" },
      { role: "assistant", content: "ok", toolCalls: [{ id: "tc1", name: "browser", arguments: '{"action":"navigate","url":"https://x.com"}' }] },
      { role: "tool", toolCallId: "tc1", content: '{"ok":true}' },
    ];
    const contents = toGeminiContents(msgs);
    expect(contents).toEqual([
      { role: "user", parts: [{ text: "open x.com" }] }, // system is dropped (→ systemInstruction)
      { role: "model", parts: [{ text: "ok" }, { functionCall: { name: "browser", args: { action: "navigate", url: "https://x.com" } } }] },
      { role: "user", parts: [{ functionResponse: { name: "browser", response: { ok: true } } }] },
    ]);
  });

  it("wraps a non-object tool result so functionResponse.response is always an object", () => {
    const contents = toGeminiContents([
      { role: "assistant", content: "", toolCalls: [{ id: "tc1", name: "read", arguments: "{}" }] },
      { role: "tool", toolCallId: "tc1", content: "plain text result" },
    ]);
    expect(contents[1].parts[0]).toEqual({ functionResponse: { name: "read", response: { result: "plain text result" } } });
  });
});

describe("buildGeminiBody", () => {
  const base: GeminiNativeRequest = {
    model: "gemini-2.5-flash",
    apiKey: "k",
    systemPrompt: "sys",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "browser", description: "drive a browser", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } }],
    signal: new AbortController().signal,
  };

  it("sets systemInstruction, functionDeclarations and AUTO tool mode", () => {
    const body = buildGeminiBody(base) as any;
    expect(body.systemInstruction).toEqual({ parts: [{ text: "sys" }] });
    expect(body.tools[0].functionDeclarations[0].name).toBe("browser");
    expect(body.toolConfig.functionCallingConfig.mode).toBe("AUTO");
  });

  it("forces a single function when forcedToolChoice is set (ANY mode)", () => {
    const body = buildGeminiBody({ ...base, forcedToolChoice: { type: "tool", name: "browser" } }) as any;
    expect(body.toolConfig.functionCallingConfig).toEqual({ mode: "ANY", allowedFunctionNames: ["browser"] });
  });

  it("requests thinking only when the flag is set", () => {
    expect((buildGeminiBody({ ...base, thinking: true }) as any).generationConfig.thinkingConfig).toEqual({ includeThoughts: true });
    expect((buildGeminiBody(base) as any).generationConfig.thinkingConfig).toBeUndefined();
  });

  it("normalizes schema to Gemini's subset: repairs property-less object, drops unsupported keywords", () => {
    const body = buildGeminiBody({
      ...base,
      tools: [{ name: "proc", description: "", parameters: { type: "object", additionalProperties: true, properties: { env: { type: "object" }, cmd: { type: "string", const: "x" } }, required: ["cmd"] } }],
    }) as any;
    const params = body.tools[0].functionDeclarations[0].parameters;
    expect(params).not.toHaveProperty("additionalProperties");
    expect(params.properties.env).toEqual({ type: "object", properties: {} }); // repaired
    expect(params.properties.cmd).toEqual({ type: "string" }); // const dropped
    expect(params.required).toEqual(["cmd"]);
  });
});

// Regression (live 2026-06-11): Gemini SSE frames are separated by CRLF blank
// lines (\r\n\r\n). The parser split on "\n\n", which never matches CRLF, so
// every frame was dropped and the transport yielded zero events ("EMPTY"). The
// real native response carries the functionCall — the bug was purely framing.
describe("defaultGeminiNativeTransport SSE parsing", () => {
  afterEach(() => vi.unstubAllGlobals());

  function mockFetchSSE(frames: string[], sep: string) {
    const body = frames.map(f => `data: ${f}`).join(sep) + sep;
    vi.stubGlobal("fetch", async () => new Response(
      new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); } }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
  }
  const req: GeminiNativeRequest = {
    model: "gemini-2.5-flash", apiKey: "k", systemPrompt: "s",
    messages: [{ role: "user", content: "open x.com" }],
    tools: [{ name: "browser", description: "", parameters: { type: "object" } }],
    signal: new AbortController().signal,
  };
  const fcFrame = JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "browser", args: { action: "navigate" } } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });

  it("parses CRLF-separated frames (the real Gemini wire) into a tool_call", async () => {
    mockFetchSSE([fcFrame], "\r\n\r\n");
    const evs: GeminiTransportEvent[] = [];
    for await (const e of defaultGeminiNativeTransport().stream(req)) evs.push(e);
    const tc = evs.find(e => e.type === "tool_call");
    expect(tc).toMatchObject({ type: "tool_call", name: "browser" });
    expect(evs.some(e => e.type === "done")).toBe(true);
  });

  it("also parses LF-only frames (defensive)", async () => {
    mockFetchSSE([fcFrame], "\n\n");
    const evs: GeminiTransportEvent[] = [];
    for await (const e of defaultGeminiNativeTransport().stream(req)) evs.push(e);
    expect(evs.some(e => e.type === "tool_call")).toBe(true);
  });

  it("surfaces an HTTP error body as an error event", async () => {
    vi.stubGlobal("fetch", async () => new Response("quota exceeded", { status: 429 }));
    const evs: GeminiTransportEvent[] = [];
    for await (const e of defaultGeminiNativeTransport().stream(req)) evs.push(e);
    expect(evs.find(e => e.type === "error")).toMatchObject({ type: "error", code: "http_429" });
  });
});

// Stub-transport adapter test: proves the adapter maps transport events to the
// canonical AdapterReport contract (text→stream_chunk, tool_call→requested,
// thinking→reasoning_chunk, plus message_finalized).
describe("GeminiNativeAdapter event mapping", () => {
  function stub(events: GeminiTransportEvent[]): GeminiNativeTransport {
    return { async *stream() { for (const e of events) yield e; } };
  }
  const turn: TurnInput = { opId: "op1", turnIdx: 0, messages: [{ messageId: "m0", role: "user", content: { text: "open x.com" } }], tools: [{ name: "browser", description: "", inputSchema: { type: "object" } }] };

  it("emits reasoning_chunk for thinking, stream_chunk for text, tool_call_requested for functionCall", async () => {
    const adapter = createGeminiNativeAdapter({
      model: "gemini-2.5-flash", apiKey: "k",
      transport: stub([
        { type: "thinking", delta: "considering" },
        { type: "text", delta: "Opening" },
        { type: "tool_call", id: "g1", name: "browser", arguments: '{"action":"navigate"}' },
        { type: "done", stopReason: "STOP" },
      ]),
    });
    const reports: AdapterReport[] = [];
    const res = await adapter.runTurn(turn, r => reports.push(r));
    // Since 78213fb2 a reasoning delta streams as a live reasoning_chunk
    // (which resets the idle watchdog) rather than a payload-less heartbeat.
    expect(reports.filter(r => r.kind === "reasoning_chunk")).toHaveLength(1);
    expect(reports.filter(r => r.kind === "stream_chunk")).toHaveLength(1);
    const calls = reports.filter(r => r.kind === "tool_call_requested");
    expect(calls).toHaveLength(1);
    expect((calls[0] as { call: { tool: string } }).call.tool).toBe("browser");
    const finalized = reports.find(r => r.kind === "message_finalized");
    expect(finalized).toBeTruthy();
    // tool-only/with-text turn pends → terminalReason undefined (loop continues to dispatch)
    expect(res.terminalReason).toBeUndefined();
  });

  it("surfaces a transport error and terminates with error", async () => {
    const adapter = createGeminiNativeAdapter({
      model: "gemini-2.5-flash", apiKey: "k",
      transport: stub([{ type: "error", code: "http_429", message: "rate limited", retryable: true }, { type: "done" }]),
    });
    const reports: AdapterReport[] = [];
    const res = await adapter.runTurn(turn, r => reports.push(r));
    expect(reports.some(r => r.kind === "error")).toBe(true);
    expect(res.terminalReason).toBe("error");
  });
});
