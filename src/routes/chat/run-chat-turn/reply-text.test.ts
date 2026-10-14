import { describe, it, expect } from "vitest";
import { ReplyText } from "./reply-text.js";

// The server's copy of the chat reducer's tool-boundary break
// (public/js/chat-stream-reducer.js: toolsSinceText && content && !endsWith('\n')).
describe("ReplyText — a reply across tool rounds", () => {
  it("opens a new paragraph for text that follows a tool", () => {
    const r = new ReplyText();
    r.append("Let me remove it.");
    r.toolBoundary();
    r.append("Fair point.");
    expect(r.value).toBe("Let me remove it.\n\nFair point.");
  });

  it("adds no break without a tool, before any text, or after a newline", () => {
    const r = new ReplyText();
    r.toolBoundary();
    r.append("one ");
    r.append("two\n");
    r.toolBoundary();
    r.append("three");
    expect(r.value).toBe("one two\nthree");
  });

  it("a replace takes the whole reply and clears a pending break", () => {
    const r = new ReplyText();
    r.append("draft");
    r.toolBoundary();
    r.set("final");
    r.append(" text");
    expect(r.value).toBe("final text");
  });
});
