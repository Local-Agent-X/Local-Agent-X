import { describe, it, expect } from "vitest";
import { streamConsume } from "./stream-consume.js";
import type { AnthropicTransport, AnthropicTransportRequest, TransportEvent } from "./types.js";
import type { AdapterReport } from "../../adapter-contract.js";

function makeReq(): AnthropicTransportRequest {
  return {
    model: "claude-opus",
    systemPrompt: "",
    messages: [],
    tools: [],
    signal: new AbortController().signal,
  };
}

// Fake transport whose stream() replays a fixed TransportEvent list.
function transportYielding(events: TransportEvent[]): AnthropicTransport {
  return {
    async *stream() {
      for (const e of events) yield e;
    },
  };
}

describe("streamConsume tool_observed handling", () => {
  it("reports an out-of-band tool without registering an outstanding tool call", async () => {
    // The CLI/MCP path runs Claude's tools inside the subprocess; they reach
    // us only as `tool_observed`. We must record the NAME for op-category
    // telemetry but NOT count it as an outstanding tool call — otherwise the
    // turn looks like it has work pending and its terminalReason flips.
    const transport = transportYielding([
      { type: "tool_observed", name: "mcp__lax__browser" },
      { type: "done" },
    ]);
    const reports: AdapterReport[] = [];
    const result = await streamConsume(transport, makeReq(), (r) => reports.push(r), {
      isAborted: () => false,
    });

    expect(reports).toContainEqual({ kind: "tool_observed", tool: "mcp__lax__browser" });
    expect(result.toolCallIds).toHaveLength(0);
  });
});

describe("streamConsume refusal handling", () => {
  it("a `refusal` stop with no text is a non-retryable error the chat can show, not a clean empty turn", async () => {
    const transport = transportYielding([
      { type: "thinking", delta: "considering" },
      { type: "done", stopReason: "refusal" },
    ] as TransportEvent[]);
    const reports: AdapterReport[] = [];
    const result = await streamConsume(transport, makeReq(), (r) => reports.push(r), {
      isAborted: () => false,
    });

    expect(result.firstError?.code).toBe("model_refusal");
    expect(result.firstError?.message).toMatch(/content policy/);
    expect(reports).toContainEqual({ kind: "error", code: "model_refusal", message: result.firstError?.message, retryable: false });
  });

  it("an ordinary end_turn stays clean", async () => {
    const transport = transportYielding([{ type: "text", delta: "hi" }, { type: "done", stopReason: "end_turn" }] as TransportEvent[]);
    const reports: AdapterReport[] = [];
    const result = await streamConsume(transport, makeReq(), (r) => reports.push(r), { isAborted: () => false });
    expect(result.firstError).toBeNull();
    expect(reports.some((r) => r.kind === "error")).toBe(false);
  });
});

describe("streamConsume tool-call args go through the shared repairing guard", () => {
  async function argsOf(raw: string): Promise<unknown> {
    const transport = transportYielding([
      { type: "tool_call", id: "toolu_1", name: "write", arguments: raw },
      { type: "done", stopReason: "tool_use" },
    ] as TransportEvent[]);
    const reports: AdapterReport[] = [];
    await streamConsume(transport, makeReq(), (r) => reports.push(r), { isAborted: () => false });
    const req = reports.find((r) => r.kind === "tool_call_requested");
    return req && req.kind === "tool_call_requested" ? req.call.args : undefined;
  }

  it("complete args parse unchanged", async () => {
    expect(await argsOf('{"path":"a.txt"}')).toEqual({ path: "a.txt" });
  });

  it("a cosmetic slip (trailing comma) is repaired, as on every other adapter", async () => {
    expect(await argsOf('{"path":"a.txt",}')).toEqual({ path: "a.txt" });
  });

  it("args cut off mid-stream (max_tokens inside input_json_delta) stay {_raw} and never complete", async () => {
    const raw = '{"path":"a.txt","content":"partial';
    expect(await argsOf(raw)).toEqual({ _raw: raw });
  });
});
