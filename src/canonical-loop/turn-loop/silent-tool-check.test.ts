import { describe, it, expect } from "vitest";
import { isSilentToolCall } from "./silent-tool-check.js";
import type { ToolCall } from "../contract-types.js";

function call(tool: string, args: unknown = {}): ToolCall {
  return { id: "1", toolCallId: "1", tool, args } as unknown as ToolCall;
}

describe("isSilentToolCall", () => {
  it("voice_visual is silent (fire-and-forget UI tool — no follow-up turn)", () => {
    // Regression: when this was false, a voice turn that morphed the sphere
    // drove a wrap-up turn and the model re-spoke its reply (doubled).
    expect(isSilentToolCall(call("voice_visual", { kind: "mood", value: "happy" }))).toBe(true);
  });

  it("memory writes are silent", () => {
    expect(isSilentToolCall(call("memory_save"))).toBe(true);
  });

  it("silent browser actions are silent; data-returning ones are not", () => {
    expect(isSilentToolCall(call("browser", { action: "click" }))).toBe(true);
    expect(isSilentToolCall(call("browser", { action: "snapshot" }))).toBe(false);
  });

  it("data-returning tools are NOT silent (model needs the result)", () => {
    expect(isSilentToolCall(call("web_fetch"))).toBe(false);
    expect(isSilentToolCall(call("bash"))).toBe(false);
  });
});
