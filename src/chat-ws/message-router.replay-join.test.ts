import { describe, it, expect } from "vitest";
import { joinAssistantText } from "./message-router.js";

// Reconnect replay must collapse an op's committed assistant messages into
// ONE replace payload — the client's replace handler sets `content = text`
// wholesale, so per-message replaces left only the last message's text in
// the live bubble (and the client persisted the truncation on done).
//
// Seeds are not commits: op files also carry the prior session history as
// "hist-"-stamped assistant rows (seed-messages.ts) for provider context.
// Those must never reach the bubble — the join filters them out.

const asst = (text: unknown, messageId?: string) => ({ role: "assistant", content: { text }, messageId });

describe("joinAssistantText", () => {
  it("joins multiple assistant messages in order with a blank line between", () => {
    const messages = [asst("first pass"), asst("after the tool"), asst("wrap-up")];
    expect(joinAssistantText(messages)).toBe("first pass\n\nafter the tool\n\nwrap-up");
  });

  it("skips non-assistant messages", () => {
    const messages = [
      { role: "user", content: { text: "question" } },
      asst("answer"),
      { role: "tool", content: { text: "tool output" } },
      asst("follow-up"),
    ];
    expect(joinAssistantText(messages)).toBe("answer\n\nfollow-up");
  });

  it("skips empty and non-string texts without leaving stray separators", () => {
    const messages = [
      asst(""),
      asst("real text"),
      asst(undefined),
      asst(42),
      { role: "assistant", content: null },
      { role: "assistant" },
      asst("more text"),
    ];
    expect(joinAssistantText(messages)).toBe("real text\n\nmore text");
  });

  it("returns empty string for zero assistant messages (caller sends nothing)", () => {
    expect(joinAssistantText([])).toBe("");
    expect(joinAssistantText([{ role: "user", content: { text: "hi" } }])).toBe("");
  });

  it("excludes seeded history rows — only the op's committed output replays", () => {
    // Mirrors a real seeded op file: prior turn's reply seeded as "hist-",
    // current turn's user message as "um-", then the turn's committed
    // assistant messages (multi-iteration: text → tool → more text).
    const messages = [
      asst("prior turn's reply", "hist-op1-0-1-abc123"),
      { role: "user", content: { text: "current question" }, messageId: "um-op1-1-0-def456" },
      asst("committed first", "am-op1-1-1-aaa111"),
      asst("committed second", "am-op1-1-3-bbb222"),
    ];
    expect(joinAssistantText(messages)).toBe("committed first\n\ncommitted second");
  });

  it("returns empty string when the op holds ONLY seeded history assistant rows", () => {
    const messages = [
      asst("old reply one", "hist-op1-0-1-abc123"),
      asst("old reply two", "hist-op1-1-2-def456"),
    ];
    expect(joinAssistantText(messages)).toBe("");
  });
});
