/**
 * Claude's thinking blocks: kept whole from the stream, stored on the
 * assistant row, sent back first in that message on the next step, and, if
 * the API ever refuses them, the step is sent again once without them.
 * Checked live (Opus 5.5, Fable 5.2, Sonnet 5.5; 2026-11-13): replay is
 * accepted, also after the digest before it changed; an altered signature
 * is refused with a 400.
 */
import { describe, expect, it } from "vitest";
import { newSseState, sseEvents } from "../../anthropic-client/stream-events.js";
import { convertMessages } from "../../anthropic-client/request.js";
import { AnthropicAdapter, type AnthropicTransport, type AnthropicTransportRequest } from "./anthropic.js";
import type { AdapterReport, TurnInput } from "../adapter-contract.js";
import type { CanonicalMessage } from "../contract-types.js";

const thinking = { type: "thinking", thinking: "Work it out.", signature: "SIG" };
const redacted = { type: "redacted_thinking", data: "OPAQUE" };

describe("stream events keep thinking blocks whole", () => {
  it("collects text, signature and redacted blocks, and still emits the tool call", () => {
    const s = newSseState();
    const frames = [
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Work it " } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "out." } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "OPAQUE" } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tu_1", name: "read" } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{}" } },
      { type: "content_block_stop", index: 2 },
    ];
    const events = frames.flatMap((f) => [...sseEvents(f, s, (n) => n)]);
    expect(s.thinkingBlocks).toEqual([thinking, redacted]);
    expect(events.filter((e) => e.type === "thinking").map((e) => e.delta).join("")).toBe("Work it out.");
    expect(events.find((e) => e.type === "tool_call")).toMatchObject({ id: "tu_1", name: "read", arguments: "{}" });
  });
});

describe("convertMessages puts a row's thinking first", () => {
  it("leads the assistant message with the blocks, in order, unchanged", () => {
    const out = convertMessages([
      { role: "user", content: "go" },
      { role: "assistant", content: "Reading.", tool_calls: [{ id: "tu_1", type: "function", function: { name: "read", arguments: "{}" } }], _thinking: [thinking, redacted] } as never,
    ]);
    expect((out[1].content as Array<{ type: string }>).map((c) => c.type)).toEqual(["thinking", "redacted_thinking", "text", "tool_use"]);
    expect((out[1].content as unknown[])[0]).toEqual(thinking);
  });

  it("never sends thinking alone in a message", () => {
    const out = convertMessages([{ role: "user", content: "go" }, { role: "assistant", content: "  ", _thinking: [thinking] } as never]);
    expect(out).toHaveLength(1);
  });
});

describe("the adapter stores and replays thinking", () => {
  const user: CanonicalMessage = { messageId: "u1", role: "user", content: { text: "go" } };
  type Ev = Record<string, unknown>;
  function transport(script: Array<(req: AnthropicTransportRequest) => Ev[]>, seen: AnthropicTransportRequest[]): AnthropicTransport {
    return { async *stream(req) { seen.push(req); for (const e of script[Math.min(seen.length - 1, script.length - 1)](req)) yield e as never; } };
  }
  async function turn(adapter: AnthropicAdapter, messages: CanonicalMessage[]) {
    const reports: AdapterReport[] = [];
    await adapter.runTurn({ opId: "op", turnIdx: 0, messages, tools: [] } as unknown as TurnInput, (r) => reports.push(r));
    const fin = reports.find((r) => r.kind === "message_finalized");
    return { reports, row: fin?.kind === "message_finalized" ? fin.message : undefined };
  }
  const toolStep: Ev[] = [{ type: "tool_call", id: "tu_1", name: "read", arguments: "{}" }, { type: "done", stopReason: "tool_use", thinkingBlocks: [thinking] }];
  const toolRow: CanonicalMessage = { messageId: "t1", role: "tool_result", content: { toolCallId: "tu_1", result: "ok" } };

  it("keeps the blocks on the row and sends them back on the next step", async () => {
    const seen: AnthropicTransportRequest[] = [];
    const a = new AnthropicAdapter({ model: "claude-opus-5-5", transport: transport([() => toolStep, () => [{ type: "text", delta: "done" }, { type: "done", stopReason: "end_turn" }]], seen) });
    const { row } = await turn(a, [user]);
    expect((row!.content as { reasoningPayload?: unknown }).reasoningPayload).toEqual({ provider: "anthropic", model: "claude-opus-5-5", data: [thinking] });
    await turn(a, [user, row!, toolRow]);
    expect(seen[1].messages.find((m) => m.role === "assistant")?.reasoningPayload).toEqual([thinking]);
  });

  it("a refused replay is sent again without it, unreported, and replay stays off", async () => {
    const seen: AnthropicTransportRequest[] = [];
    const refuse: Ev[] = [{ type: "error", code: "transport_error", message: "Anthropic 400: messages.1.content.0: Invalid `signature` in `thinking` block" }, { type: "done" }];
    const ok: Ev[] = [{ type: "text", delta: "done" }, { type: "done", stopReason: "end_turn" }];
    const a = new AnthropicAdapter({ model: "claude-opus-5-5", transport: transport([() => toolStep, (req) => (req.messages.some((m) => m.reasoningPayload) ? refuse : ok), () => ok], seen) });
    const { row } = await turn(a, [user]);
    const { reports } = await turn(a, [user, row!, toolRow]);
    expect(seen).toHaveLength(3);
    expect(seen[2].messages.some((m) => m.reasoningPayload)).toBe(false);
    expect(reports.some((r) => r.kind === "error")).toBe(false);
    expect(reports.some((r) => r.kind === "message_finalized")).toBe(true);
    await turn(a, [user, row!, toolRow]);
    expect(seen[3].messages.some((m) => m.reasoningPayload)).toBe(false);
  });

  it("an unrelated error during a replayed step is still reported, and not retried", async () => {
    const seen: AnthropicTransportRequest[] = [];
    const overloaded: Ev[] = [{ type: "error", code: "transport_error", message: "Anthropic 400: tools.0.input_schema: invalid" }, { type: "done" }];
    const a = new AnthropicAdapter({ model: "claude-opus-5-5", transport: transport([() => toolStep, () => overloaded], seen) });
    const { row } = await turn(a, [user]);
    const { reports } = await turn(a, [user, row!, toolRow]);
    expect(reports.some((r) => r.kind === "error")).toBe(true);
    expect(seen.filter((r) => r.messages.length > 1)).toHaveLength(1);
  });
});
