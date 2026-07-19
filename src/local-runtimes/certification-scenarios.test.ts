import { describe, expect, it } from "vitest";
import { LOCAL_MODEL_CERTIFICATION_SCENARIOS } from "./certification-scenarios.js";

const requiredTool = LOCAL_MODEL_CERTIFICATION_SCENARIOS.find((scenario) => (
  scenario.id === "required_tool_call"
));

function response(call: Record<string, unknown>): unknown {
  return { choices: [{ message: { tool_calls: [call] } }] };
}

function responseWithCalls(calls: Record<string, unknown>[]): unknown {
  return { choices: [{ message: { tool_calls: calls } }] };
}

describe("required tool certification", () => {
  it("requires the exact function type, name, and JSON arguments", () => {
    const valid = {
      type: "function",
      function: { name: "lax_certification_probe", arguments: "{\"ok\":true}" },
    };
    expect(requiredTool?.verify(response(valid))).toBe(true);
    for (const call of [
      { function: { name: "lax_certification_probe", arguments: "{\"ok\":true}" } },
      { type: "function", function: { name: "other", arguments: "{\"ok\":true}" } },
      { type: "function", function: { name: "lax_certification_probe", arguments: "not-json" } },
      { type: "function", function: { name: "lax_certification_probe", arguments: "{\"ok\":false}" } },
      { type: "function", function: { name: "lax_certification_probe", arguments: "{\"ok\":true,\"extra\":1}" } },
    ]) {
      expect(requiredTool?.verify(response(call))).toBe(false);
    }
    expect(requiredTool?.verify(responseWithCalls([valid, valid]))).toBe(false);
    expect(requiredTool?.verify(responseWithCalls([
      valid,
      { type: "function", function: { name: "unexpected", arguments: "{}" } },
    ]))).toBe(false);
  });
});
