// The browser tool's `press` and the phone's relayed keys, turned into input
// on either backend (key-press.ts).
import { describe, it, expect, vi, beforeEach } from "vitest";

const bridge = vi.hoisted(() => ({ sent: [] as unknown[], credentialFocused: false }));
vi.mock("./bridge-client.js", () => ({
  browserInput: async (_viewId: string, event: unknown) => { bridge.sent.push(event); },
  browserExec: async () => bridge.credentialFocused,
}));

import { bridgeKeyEvents, editsText, parseKeyPress, pressKeyCdp, pressKeyInApp, DEFAULT_HOLD_MS } from "./key-press.js";
import { PASSWORD_FIELD_REFUSAL } from "./password-field-rule.js";

beforeEach(() => { bridge.sent.length = 0; bridge.credentialFocused = false; });

describe("parseKeyPress", () => {
  it("reads a character, a named key in any case or alias, and a chord", () => {
    expect(parseKeyPress("w")).toEqual({ key: "w", modifiers: [], holdMs: DEFAULT_HOLD_MS });
    expect(parseKeyPress("arrowup", 600)).toEqual({ key: "ArrowUp", modifiers: [], holdMs: 600 });
    expect(parseKeyPress("Esc").key).toBe("Escape");
    expect(parseKeyPress(" ").key).toBe("Space");
    expect(parseKeyPress("Ctrl+Shift+a")).toEqual({ key: "a", modifiers: ["control", "shift"], holdMs: DEFAULT_HOLD_MS });
    expect(parseKeyPress("+").key).toBe("+");
  });

  it("refuses an unknown key or modifier and a hold out of range, saying what it takes", () => {
    expect(() => parseKeyPress("")).toThrow("press needs `key`");
    expect(() => parseKeyPress("Jump")).toThrow("named key");
    expect(() => parseKeyPress("Hyper+a")).toThrow("not a modifier");
    expect(() => parseKeyPress("w", 9_000)).toThrow("hold_ms");
    expect(() => parseKeyPress("w", -1)).toThrow("hold_ms");
  });
});

describe("bridgeKeyEvents", () => {
  it("sends a character key with its char, Enter with \r, and a chord or arrow without one", () => {
    expect(bridgeKeyEvents(parseKeyPress("w"))).toEqual({
      down: [{ type: "keyDown", keyCode: "w" }, { type: "char", keyCode: "w" }],
      up: [{ type: "keyUp", keyCode: "w" }],
    });
    expect(bridgeKeyEvents(parseKeyPress("Enter")).down).toEqual([{ type: "keyDown", keyCode: "Enter" }, { type: "char", keyCode: "\r" }]);
    expect(bridgeKeyEvents(parseKeyPress("Space")).down[1]).toEqual({ type: "char", keyCode: " " });
    expect(bridgeKeyEvents(parseKeyPress("ArrowLeft"))).toEqual({ down: [{ type: "keyDown", keyCode: "Left" }], up: [{ type: "keyUp", keyCode: "Left" }] });
    expect(bridgeKeyEvents(parseKeyPress("Control+a"))).toEqual({
      down: [{ type: "keyDown", keyCode: "a", modifiers: ["control"] }],
      up: [{ type: "keyUp", keyCode: "a", modifiers: ["control"] }],
    });
  });

  it("counts characters and deletes as writing text, not Enter, arrows or a chord", () => {
    for (const k of ["w", "Space", "Backspace", "Delete", "Shift+a"]) expect(editsText(parseKeyPress(k)), k).toBe(true);
    for (const k of ["Enter", "Tab", "ArrowUp", "Escape", "Control+c"]) expect(editsText(parseKeyPress(k)), k).toBe(false);
  });
});

describe("pressKeyInApp", () => {
  it("holds the key down for hold_ms before letting it go", async () => {
    const started = Date.now();
    expect(await pressKeyInApp("v1", parseKeyPress("w", 120))).toBe("Pressed w, held 120 ms.");
    expect(Date.now() - started).toBeGreaterThanOrEqual(110);
    expect(bridge.sent.map((e) => (e as { type: string }).type)).toEqual(["keyDown", "char", "keyUp"]);
  });

  it("never types into a focused password field, but still presses Enter there", async () => {
    bridge.credentialFocused = true;
    expect(await pressKeyInApp("v1", parseKeyPress("x", 0))).toBe(PASSWORD_FIELD_REFUSAL);
    expect(bridge.sent).toEqual([]);
    expect(await pressKeyInApp("v1", parseKeyPress("Enter", 0))).toBe("Pressed Enter.");
  });
});

describe("pressKeyCdp", () => {
  function fakePage(credentialFocused = false) {
    const keys: string[] = [];
    const page = {
      evaluate: async () => credentialFocused,
      keyboard: { down: async (k: string) => { keys.push(`down:${k}`); }, up: async (k: string) => { keys.push(`up:${k}`); } },
    };
    return { page: page as never, keys };
  }

  it("holds the modifiers around the key, and lets them go in reverse", async () => {
    const { page, keys } = fakePage();
    expect(await pressKeyCdp(page, parseKeyPress("Control+Shift+Tab", 0))).toBe("Pressed Control+Shift+Tab.");
    expect(keys).toEqual(["down:Control", "down:Shift", "down:Tab", "up:Tab", "up:Shift", "up:Control"]);
  });

  it("never types into a focused password field", async () => {
    const { page, keys } = fakePage(true);
    expect(await pressKeyCdp(page, parseKeyPress("a", 0))).toBe(PASSWORD_FIELD_REFUSAL);
    expect(keys).toEqual([]);
  });
});
