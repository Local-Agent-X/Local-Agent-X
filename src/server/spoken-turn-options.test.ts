import { describe, it, expect } from "vitest";
import type { PreparedAgentRequest } from "../agent-request/types.js";
import type { ToolDefinition } from "../types.js";
import { spokenTurnAbility } from "./spoken-turn-options.js";
import { withSpokenTools } from "../agent-request/prepare-request.js";
import { toolsTagged } from "../tool-registry.js";

const tool = (name: string): ToolDefinition => ({
  name, description: `${name} does its job.`, parameters: { type: "object", properties: {} },
  execute: async () => ({ content: "", isError: false }),
} as unknown as ToolDefinition);

function preparedTyped(): PreparedAgentRequest {
  return {
    tools: [tool("email_search"), tool("memory_recall"), tool("voice_visual")],
    maxIterations: 160,
    temperature: 0.7,
    reasoningEffort: "medium",
    toolChoice: { type: "tool", name: "search_past_sessions" },
  } as unknown as PreparedAgentRequest;
}

// A spoken turn used to run as its own smaller agent (18 tools, effort "low",
// 8 steps, a forced opening tool call) and said it couldn't do what typing the
// same words then did (2026-11-11). Everything that decides what a turn can do
// must be the typed turn's value.
describe("a spoken turn can do what a typed turn can", () => {
  it("runs with the typed turn's tools, steps, sampling, reasoning and first-tool pin", () => {
    const prepared = preparedTyped();
    const ability = spokenTurnAbility(prepared, true);
    expect(ability.tools).toEqual(prepared.tools);
    expect(ability.maxIterations).toBe(prepared.maxIterations);
    expect(ability.temperature).toBe(prepared.temperature);
    expect(ability.reasoningEffort).toBe(prepared.reasoningEffort);
    expect(ability.forcedToolChoice).toEqual(prepared.toolChoice);
  });

  it("sets no effort of its own and may answer without calling a tool first", () => {
    const ability = spokenTurnAbility(preparedTyped(), true) as unknown as Record<string, unknown>;
    expect(ability).not.toHaveProperty("effort");
    expect(ability).not.toHaveProperty("disableThinking");
    expect(ability.requireToolOnFirstTurn).toBe(false);
  });

  it("drops only the sphere when the user has visuals off", () => {
    const names = spokenTurnAbility(preparedTyped(), false).tools.map((t) => t.name);
    expect(names).toEqual(["email_search", "memory_recall"]);
  });
});

describe("withSpokenTools", () => {
  const catalog = [tool("email_search"), tool("show_card"), tool("tool_search"), tool("gmail_read")];

  it("keeps the typed selection and adds the voice tools it lacks, on a spoken turn", () => {
    const selected = [tool("email_search"), tool("tool_search")];
    const names = withSpokenTools(selected, "voice", catalog, ["show_card", "tool_search"]).map((t) => t.name);
    expect(names).toEqual(["email_search", "tool_search", "show_card"]);
  });

  it("leaves every other channel's selection alone", () => {
    const selected = [tool("email_search")];
    expect(withSpokenTools(selected, "web", catalog, ["show_card"])).toBe(selected);
  });

  it("the voice tools are the rows tagged voice-fast, the sphere among them", () => {
    for (const t of ["tool_search", "memory_search", "search_past_sessions", "show_card", "voice_visual"]) {
      expect(toolsTagged("voice-fast")).toContain(t);
    }
  });
});
