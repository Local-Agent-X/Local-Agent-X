import { describe, expect, it } from "vitest";
import { isSentByApp } from "./app-message-text.js";

describe("isSentByApp", () => {
  it("knows every kind of message the app sends a chat", () => {
    expect(isSentByApp("(Sent by the app, not typed by the user: a build decision is waiting.)\n\nDecision bd-1")).toBe(true);
    expect(isSentByApp("(Sent by the app, not typed by the user: background work you started has ended.)")).toBe(true);
    expect(isSentByApp("(Collab, step 2. Sent by the app, not typed by the user. The user started it from the chat \"x\".)")).toBe(true);
    expect(isSentByApp("  (From the app, not typed by the user.) Your result does not name these disputes")).toBe(true);
  });

  it("leaves what the user typed alone, parentheses and all", () => {
    expect(isSentByApp("(quick one) can you build the scanner")).toBe(false);
    expect(isSentByApp("build it\n(not typed by the user is just words here)")).toBe(false);
    expect(isSentByApp("")).toBe(false);
  });
});
