import { describe, it, expect } from "vitest";
import { isSilentToolCall, stepClosedTurn } from "./silent-tool-check.js";
import type { ToolCall } from "../contract-types.js";
import type { ToolCallSummary } from "../types.js";
import { toolsWhere } from "../../tool-registry.js";

function call(tool: string, args: unknown = {}): ToolCall {
  return { id: "1", toolCallId: "1", tool, args } as unknown as ToolCall;
}

describe("isSilentToolCall", () => {
  it("voice_visual is silent (fire-and-forget UI tool — no follow-up turn)", () => {
    // Regression: when this was false, a voice turn that morphed the sphere
    // drove a wrap-up turn and the model re-spoke its reply (doubled).
    expect(isSilentToolCall(call("voice_visual", { kind: "mood", value: "happy" }))).toBe(true);
  });

  it("memory writes are silent — every row that declares memoryWrite", () => {
    const writes = toolsWhere((row) => row.memoryWrite === true);
    expect(writes).toEqual(expect.arrayContaining(["memory_save", "remember", "forget"]));
    for (const tool of writes) expect(isSilentToolCall(call(tool)), tool).toBe(true);
  });

  it("a fire-and-forget row is silent; a memory read is not", () => {
    for (const tool of toolsWhere((row) => row.loop?.silent === true)) expect(isSilentToolCall(call(tool)), tool).toBe(true);
    expect(isSilentToolCall(call("memory_search"))).toBe(false);
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

describe("stepClosedTurn", () => {
  const ran = (...rows: [string, string][]) => rows.map(([tool, resultStatus]) => ({ tool, resultStatus })) as unknown as ToolCallSummary[];

  it("a succeeded wrap_up closes the turn, alone or beside other calls that succeeded", () => {
    expect(stepClosedTurn([call("wrap_up")], ran(["wrap_up", "ok"]))).toBe(true);
    expect(stepClosedTurn([call("bash"), call("wrap_up")], ran(["bash", "ok"], ["wrap_up", "ok"]))).toBe(true);
  });

  it("a failed call in the same step keeps the turn open: the model has not seen that result", () => {
    expect(stepClosedTurn([call("bash"), call("wrap_up")], ran(["bash", "error"], ["wrap_up", "ok"]))).toBe(false);
    expect(stepClosedTurn([call("wrap_up")], ran(["wrap_up", "error"]))).toBe(false);
  });

  it("a call that never ran, or a step without a closing tool, closes nothing", () => {
    expect(stepClosedTurn([call("bash"), call("wrap_up")], ran(["bash", "ok"]))).toBe(false);
    expect(stepClosedTurn([call("review_changes")], ran(["review_changes", "ok"]))).toBe(false);
  });

  it("is a row fact: wrap_up declares it, ask_user does not (a question ends the turn its own way)", () => {
    expect(toolsWhere((row) => row.closesTurn === true)).toEqual(["wrap_up"]);
  });
});
