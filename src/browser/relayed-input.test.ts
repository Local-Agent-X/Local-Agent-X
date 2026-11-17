// A person's input relayed from the phone into the agent's browser while a
// human check is handed to them: a tap, a drag, a press held for seconds, or
// typed characters (a check is not always one tap).
import { describe, it, expect } from "vitest";
import { parseRelayedInput, relayedInputEvents } from "./relayed-input.js";

describe("parseRelayedInput", () => {
  it("reads a bare { x, y } as a tap, as the first phone build sends it", () => {
    expect(parseRelayedInput({ x: 0.2, y: 0.4 })).toEqual({ kind: "tap", x: 0.2, y: 0.4 });
  });

  it("takes the steps of a drag or a hold, typing and the form keys", () => {
    expect(parseRelayedInput({ kind: "press", x: 0, y: 1 })).toEqual({ kind: "press", x: 0, y: 1 });
    expect(parseRelayedInput({ kind: "move", x: 0.5, y: 0.5 })).toEqual({ kind: "move", x: 0.5, y: 0.5 });
    expect(parseRelayedInput({ kind: "release", x: 0.9, y: 0.5 })).toEqual({ kind: "release", x: 0.9, y: 0.5 });
    expect(parseRelayedInput({ kind: "text", text: "XK4P" })).toEqual({ kind: "text", text: "XK4P" });
    expect(parseRelayedInput({ kind: "key", key: "Enter" })).toEqual({ kind: "key", key: "Enter" });
  });

  it("refuses points off the picture, control characters, long text and other keys", () => {
    expect(() => parseRelayedInput({ x: 1.5, y: 0.5 })).toThrow("between 0 and 1");
    expect(() => parseRelayedInput({ kind: "move", x: "a", y: 0 })).toThrow("between 0 and 1");
    expect(() => parseRelayedInput({ kind: "text", text: "a\nb" })).toThrow("printable");
    expect(() => parseRelayedInput({ kind: "text", text: "x".repeat(201) })).toThrow("printable");
    expect(() => parseRelayedInput({ kind: "text", text: "" })).toThrow("printable");
    expect(() => parseRelayedInput({ kind: "key", key: "F12" })).toThrow("Backspace, Enter, Tab");
    expect(() => parseRelayedInput({ kind: "evaluate" })).toThrow('unknown input kind "evaluate"');
  });
});

describe("relayedInputEvents", () => {
  const at = { x: 100, y: 200 };

  it("holds the left button down from press to release, and marks the moves in between as held", () => {
    expect(relayedInputEvents({ kind: "press", x: 0, y: 0 }, at)).toEqual([
      { type: "mouseMove", x: 100, y: 200 },
      { type: "mouseDown", x: 100, y: 200, button: "left", clickCount: 1 },
    ]);
    expect(relayedInputEvents({ kind: "move", x: 0, y: 0 }, at)).toEqual([
      { type: "mouseMove", x: 100, y: 200, button: "left", modifiers: ["leftButtonIsDown"] },
    ]);
    expect(relayedInputEvents({ kind: "release", x: 0, y: 0 }, at).map((e) => e.type)).toEqual(["mouseMove", "mouseUp"]);
  });

  it("types each character, and presses then lets go of a key", () => {
    expect(relayedInputEvents({ kind: "text", text: "ab" }, null)).toEqual([
      { type: "char", keyCode: "a" }, { type: "char", keyCode: "b" },
    ]);
    expect(relayedInputEvents({ kind: "key", key: "Backspace" }, null)).toEqual([
      { type: "keyDown", keyCode: "Backspace" }, { type: "keyUp", keyCode: "Backspace" },
    ]);
  });
});
