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
