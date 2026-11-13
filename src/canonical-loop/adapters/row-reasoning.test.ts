/**
 * Which assistant rows' reasoning goes back to the model: the current tool
 * loop's, from the same provider and model, under the size cap.
 */
import { describe, it, expect } from "vitest";
import { MAX_REASONING_PAYLOAD_BYTES, reasoningPayload, replayableReasoning } from "./row-reasoning.js";
import { canonicalToTransport } from "./canonical-to-transport.js";
import type { CanonicalMessage } from "../contract-types.js";

const user = (id: string): CanonicalMessage => ({ messageId: id, role: "user", content: { text: id } });
const tool = (id: string): CanonicalMessage => ({ messageId: id, role: "tool_result", content: { toolCallId: "c", result: "ok" } });
const asst = (id: string, provider = "codex", model = "gpt-6.1-sol"): CanonicalMessage => ({
  messageId: id, role: "assistant",
  content: { text: "", toolCalls: [{ id: "c", name: "read", arguments: "{}" }], reasoningPayload: { provider, model, data: [{ type: "reasoning", encrypted_content: `enc-${id}` }] } },
});

describe("replayableReasoning", () => {
  it("returns the current tool loop's rows only, not an earlier turn's", () => {
    const msgs = [user("u1"), asst("a1"), tool("t1"), user("u2"), asst("a2"), tool("t2"), asst("a3"), tool("t3")];
    expect([...replayableReasoning(msgs, "codex", "gpt-6.1-sol").keys()]).toEqual(["a2", "a3"]);
  });

  it("does not count the trailing per-step rows as a new user turn", () => {
    const msgs = [user("u1"), asst("a1"), tool("t1"), user("digest")];
    expect([...replayableReasoning(msgs, "codex", "gpt-6.1-sol", 1).keys()]).toEqual(["a1"]);
    expect([...replayableReasoning(msgs, "codex", "gpt-6.1-sol", 0).keys()]).toEqual([]);
  });

  it("never sends one provider's or model's reasoning to another", () => {
    const msgs = [user("u1"), asst("a1", "anthropic", "claude-opus-5-5"), tool("t1"), asst("a2", "codex", "gpt-5.6-sol"), tool("t2"), asst("a3")];
    expect([...replayableReasoning(msgs, "codex", "gpt-6.1-sol").keys()]).toEqual(["a3"]);
  });

  it("ignores a row without a well-formed payload", () => {
    const bad: CanonicalMessage = { messageId: "x", role: "assistant", content: { text: "hi", reasoningPayload: { provider: "codex" } } };
    expect(replayableReasoning([user("u"), bad], "codex", "gpt-6.1-sol").size).toBe(0);
  });
});

describe("reasoningPayload", () => {
  it("keeps nothing for an empty turn or one over the cap", () => {
    expect(reasoningPayload("codex", "m", [])).toBeUndefined();
    expect(reasoningPayload("codex", "m", undefined)).toBeUndefined();
    expect(reasoningPayload("codex", "m", ["x".repeat(MAX_REASONING_PAYLOAD_BYTES + 1)])).toBeUndefined();
    expect(reasoningPayload("codex", "m", [{ encrypted_content: "e" }])).toEqual({ provider: "codex", model: "m", data: [{ encrypted_content: "e" }] });
  });
});

describe("canonicalToTransport with reasoning", () => {
  it("puts each chosen row's payload on its transport row, and no other", () => {
    const msgs = [user("u1"), asst("a1"), tool("t1"), asst("a2")];
    const out = canonicalToTransport(msgs, undefined, undefined, undefined, new Map([["a2", ["payload-a2"]]]));
    const assistants = out.filter((m) => m.role === "assistant");
    expect(assistants[0].reasoningPayload).toBeUndefined();
    expect(assistants[1].reasoningPayload).toEqual(["payload-a2"]);
  });

  it("sends nothing back when no map is given", () => {
    const out = canonicalToTransport([user("u1"), asst("a1")], undefined);
    expect(out.some((m) => "reasoningPayload" in m)).toBe(false);
  });
});
