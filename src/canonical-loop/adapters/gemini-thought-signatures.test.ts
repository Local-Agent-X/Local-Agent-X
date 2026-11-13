/**
 * Gemini thought signatures: kept from the response, returned on the call
 * they came with, and the documented placeholder on a current-turn call the
 * API did not sign (Gemini 3 refuses such a request with a 400). Rules from
 * Google's thought-signatures guide, 2026-11-13; not probed live (no Gemini
 * key on the dev box).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultGeminiNativeTransport, SKIP_SIGNATURE_VALIDATOR, toGeminiContents,
  type GeminiNativeRequest, type GeminiNativeTransport, type GeminiTransportEvent,
} from "./gemini-native-transport.js";
import { GeminiNativeAdapter } from "./gemini-native.js";
import type { TransportMessage } from "./anthropic.js";
import type { AdapterReport, TurnInput } from "../adapter-contract.js";
import type { CanonicalMessage } from "../contract-types.js";

type Part = { functionCall?: unknown; thoughtSignature?: string; functionResponse?: unknown; text?: string };
const partsOf = (c: { parts: unknown[] }) => c.parts as Part[];

describe("the transport keeps each call's signature", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports it on done, by the call's id", async () => {
    const frame = JSON.stringify({ candidates: [{ content: { parts: [
      { functionCall: { name: "read", args: {} }, thoughtSignature: "SIG-A" },
      { functionCall: { name: "grep", args: {} } },
    ] }, finishReason: "STOP" }] });
    vi.stubGlobal("fetch", async () => new Response(
      new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`data: ${frame}\r\n\r\n`)); c.close(); } }),
      { status: 200 },
    ));
    const req: GeminiNativeRequest = { model: "gemini-3.1-pro-preview", apiKey: "k", systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [], signal: new AbortController().signal };
    const evs: GeminiTransportEvent[] = [];
    for await (const e of defaultGeminiNativeTransport().stream(req)) evs.push(e);
    const calls = evs.filter((e) => e.type === "tool_call") as Array<{ id: string }>;
    const done = evs.find((e) => e.type === "done") as { thoughtSignatures?: Record<string, string> };
    expect(done.thoughtSignatures).toEqual({ [calls[0].id]: "SIG-A" });
  });
});

describe("toGeminiContents", () => {
  const user = (content: string): TransportMessage => ({ role: "user", content });
  const asst = (ids: string[], sigs?: Record<string, string>): TransportMessage => ({
    role: "assistant", content: "", toolCalls: ids.map((id) => ({ id, name: "read", arguments: "{}" })), ...(sigs ? { reasoningPayload: sigs } : {}),
  });
  const result = (id: string): TransportMessage => ({ role: "tool", toolCallId: id, content: "ok" });

  it("returns a signature on the call it came with, unchanged", () => {
    const c = toGeminiContents([user("go"), asst(["a"], { a: "SIG-A" }), result("a")], "gemini-3.1-pro-preview");
    expect(partsOf(c[1])[0].thoughtSignature).toBe("SIG-A");
  });

  it("puts the placeholder on the first unsigned call of each current-turn step, and only there", () => {
    const c = toGeminiContents([user("old"), asst(["x"]), result("x"), user("go"), asst(["a", "b"]), result("a"), result("b"), asst(["c"])], "gemini-3.1-pro-preview");
    expect(partsOf(c[1])[0].thoughtSignature).toBeUndefined(); // an earlier turn is not checked
    expect(partsOf(c[4]).map((p) => p.thoughtSignature)).toEqual([SKIP_SIGNATURE_VALIDATOR, undefined]); // parallel: the first only
    expect(partsOf(c[c.length - 1])[0].thoughtSignature).toBe(SKIP_SIGNATURE_VALIDATOR);
  });

  it("a trailing user row starts a new turn: nothing before it is checked", () => {
    const c = toGeminiContents([user("go"), asst(["a"]), result("a"), user("status digest")], "gemini-3.1-pro-preview");
    expect(partsOf(c[1])[0].thoughtSignature).toBeUndefined();
  });

  it("adds no placeholder for a model that does not check signatures", () => {
    const c = toGeminiContents([user("go"), asst(["a"]), result("a")], "gemini-2.5-flash");
    expect(partsOf(c[1])[0].thoughtSignature).toBeUndefined();
  });
});

describe("the adapter keeps and replays signatures", () => {
  function transport(events: Array<Record<string, unknown>>, seen: GeminiNativeRequest[]): GeminiNativeTransport {
    return { async *stream(req: GeminiNativeRequest) { seen.push(req); for (const e of events) yield e as GeminiTransportEvent; } };
  }
  const user: CanonicalMessage = { messageId: "u1", role: "user", content: { text: "go" } };

  it("stores the signatures on the row and sends them back next step", async () => {
    const reports: AdapterReport[] = [];
    const first = new GeminiNativeAdapter({ model: "gemini-3.1-pro-preview", apiKey: "k", transport: transport([
      { type: "tool_call", id: "gem_1", name: "read", arguments: "{}" },
      { type: "done", stopReason: "STOP", thoughtSignatures: { gem_1: "SIG-1" } },
    ], []) });
    await first.runTurn({ opId: "op", turnIdx: 0, messages: [user], tools: [] } as unknown as TurnInput, (r) => reports.push(r));
    const fin = reports.find((r) => r.kind === "message_finalized");
    const row = fin?.kind === "message_finalized" ? fin.message : undefined;
    expect((row?.content as { reasoningPayload?: unknown }).reasoningPayload).toEqual({ provider: "gemini", model: "gemini-3.1-pro-preview", data: { gem_1: "SIG-1" } });

    const seen: GeminiNativeRequest[] = [];
    const next = new GeminiNativeAdapter({ model: "gemini-3.1-pro-preview", apiKey: "k", transport: transport([{ type: "done", stopReason: "STOP" }], seen) });
    const toolRow: CanonicalMessage = { messageId: "t1", role: "tool_result", content: { toolCallId: "gem_1", result: "ok" } };
    await next.runTurn({ opId: "op", turnIdx: 1, messages: [user, row!, toolRow], tools: [] } as unknown as TurnInput, () => {});
    const contents = toGeminiContents(seen[0].messages, seen[0].model);
    expect(partsOf(contents[1])[0].thoughtSignature).toBe("SIG-1");
  });
});
