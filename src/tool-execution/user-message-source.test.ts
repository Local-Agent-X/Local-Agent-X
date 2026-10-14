// A memory write records the user message it answered (facts.source_message_id,
// schema v19), stamped by the server — so "you told me that" can point at the
// exact words, and search_past_sessions(message_id) can show them.
import { describe, it, expect } from "vitest";
import { appendOpMessage } from "../canonical-loop/index.js";
import { latestUserMessageId } from "./resolve-tool.js";

const row = (opId: string, seq: number, messageId: string, role: "user" | "assistant" | "tool_result", content: Record<string, unknown>) =>
  appendOpMessage({ messageId, opId, turnIdx: 0, seqInTurn: seq, role, content, createdAt: new Date().toISOString() });

describe("latestUserMessageId — the message a memory write answers", () => {
  it("is the turn's own user message, past history, carried recall, a nudge and the tool rows", () => {
    const opId = `op_user_msg_${Date.now()}`;
    row(opId, 0, `hist-${opId}-0`, "user", { text: "an earlier question" });
    row(opId, 1, `hist-${opId}-1`, "user", { text: "Recalled memory …", kind: "recall" });
    row(opId, 2, `um-${opId}-0-2`, "user", { text: "Remember: my cousin Odalys texted my brother in 2014." });
    row(opId, 3, `am-${opId}`, "assistant", { text: "", toolCalls: [{ id: "c1", name: "remember", arguments: "{}" }] });
    row(opId, 4, `tr-${opId}`, "tool_result", { text: "Remembered #1", toolCallId: "c1" });
    row(opId, 5, `nudge-${opId}`, "user", { text: "[automatic check] …", kind: "nudge" });
    expect(latestUserMessageId(opId)).toBe(`um-${opId}-0-2`);
  });

  it("is undefined for an op with no user message", () => {
    expect(latestUserMessageId(`op_empty_${Date.now()}`)).toBeUndefined();
  });
});
