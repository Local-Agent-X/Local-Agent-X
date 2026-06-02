import { describe, it, expect } from "vitest";
import { collapseAdjacentUserMessages } from "./build-input.js";
import type { CanonicalMessage } from "../contract-types.js";

const user = (id: string, text: string): CanonicalMessage => ({ messageId: id, role: "user", content: { text } });
const assistant = (id: string, text: string): CanonicalMessage => ({ messageId: id, role: "assistant", content: { text } });

describe("collapseAdjacentUserMessages", () => {
  it("merges a rapid double-send into one user turn", () => {
    const out = collapseAdjacentUserMessages([
      user("a", "I want to start a company"),
      user("b", "doing active shooter training"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("user");
    expect((out[0].content as { text: string }).text).toBe(
      "I want to start a company\n\ndoing active shooter training",
    );
  });

  it("merges the question + nudge left adjacent after a retracted hallucination", () => {
    // user question, assistant lie dropped, nudge appended as a user message
    const out = collapseAdjacentUserMessages([
      user("q", "I want to start a company"),
      user("n", "You did NOT spawn a worker. Answer the user directly."),
    ]);
    expect(out).toHaveLength(1);
    expect((out[0].content as { text: string }).text).toContain("start a company");
    expect((out[0].content as { text: string }).text).toContain("did NOT spawn");
  });

  it("preserves alternation — does not touch user/assistant pairs", () => {
    const msgs = [user("a", "hi"), assistant("b", "hello"), user("c", "bye")];
    expect(collapseAdjacentUserMessages(msgs)).toEqual(msgs);
  });

  it("leaves image-bearing user rows standalone", () => {
    const withImg: CanonicalMessage = {
      messageId: "img",
      role: "user",
      content: { text: "look at this", images: [{ url: "data:...", name: "x.png" }] },
    };
    const out = collapseAdjacentUserMessages([user("a", "first"), withImg]);
    expect(out).toHaveLength(2);
    expect(out[1]).toBe(withImg);
  });

  it("collapses a run of three plain user messages", () => {
    const out = collapseAdjacentUserMessages([user("a", "one"), user("b", "two"), user("c", "three")]);
    expect(out).toHaveLength(1);
    expect((out[0].content as { text: string }).text).toBe("one\n\ntwo\n\nthree");
  });

  it("is a no-op on an empty history", () => {
    expect(collapseAdjacentUserMessages([])).toEqual([]);
  });
});
