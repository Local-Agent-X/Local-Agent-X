// The ephemeral-tail count is the ONE cache field sourced per-TURN (from
// TurnInput) rather than from the adapter's construction-time options, so it
// is the one most likely to be dropped by a future refactor of the req
// literal. Losing it is silent: the request still succeeds, the conversation
// just stops caching and every turn re-writes the whole history at 1.25x.
import { describe, it, expect } from "vitest";
import { AnthropicAdapter } from "./anthropic.js";
import type { AnthropicTransport, AnthropicTransportRequest, TransportEvent } from "./anthropic.js";
import type { TurnInput } from "../adapter-contract.js";

function capturingTransport(seen: AnthropicTransportRequest[]): AnthropicTransport {
  return {
    async *stream(req: AnthropicTransportRequest): AsyncIterable<TransportEvent> {
      seen.push(req);
      yield { type: "text", delta: "ok" };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
}

function turnInput(extra: Partial<TurnInput> = {}): TurnInput {
  return {
    opId: "op-tail",
    turnIdx: 1,
    messages: [
      { messageId: "u0", role: "user", content: { text: "ship it" } },
      { messageId: "a0", role: "assistant", content: { text: "on it" } },
      { messageId: "sa", role: "user", content: { text: "[SITUATIONAL CONTEXT …]" } },
    ],
    tools: [],
    ...extra,
  };
}

describe("AnthropicAdapter — ephemeral tail plumbing", () => {
  it("forwards TurnInput.ephemeralTailMessages onto the transport request", async () => {
    const seen: AnthropicTransportRequest[] = [];
    const adapter = new AnthropicAdapter({ transport: capturingTransport(seen), cacheConversation: true });
    await adapter.runTurn(turnInput({ ephemeralTailMessages: 1 }), () => {});
    expect(seen).toHaveLength(1);
    expect(seen[0].ephemeralTailMessages).toBe(1);
    // The digest itself still rides on the wire — the breakpoint moves, the
    // content does not get dropped.
    expect(seen[0].messages[seen[0].messages.length - 1].content).toContain("SITUATIONAL CONTEXT");
  });

  it("leaves the field absent when the loop declares no ephemeral tail", async () => {
    const seen: AnthropicTransportRequest[] = [];
    const adapter = new AnthropicAdapter({ transport: capturingTransport(seen), cacheConversation: true });
    await adapter.runTurn(turnInput(), () => {});
    expect(seen[0].ephemeralTailMessages).toBeUndefined();
  });
});
