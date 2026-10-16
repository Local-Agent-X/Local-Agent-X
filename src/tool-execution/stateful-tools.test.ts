// A tool's live state is its policy row's `liveState`, and the three repeat
// layers read it from there. "poll" tools are exempt from the threat engine's
// repeat arms because an identical repeat is how they wait; "fresh" tools are
// never answered from an earlier result but stay loop-guarded.
import { describe, expect, it } from "vitest";
import { LIVE_STATE_TOOLS, STATEFUL_LIVE_STATE_TOOLS } from "./stateful-tools.js";
import { getToolTimeout, DEFAULT_FALLBACK } from "./tool-timeout.js";
import { ToolChainAnalyzer } from "../threat/tool-chain.js";

const clean = { labels: [], confidence: 0 };
const repeat = (tool: string, args: Record<string, unknown>, times: number) => {
  const chain = new ToolChainAnalyzer(`live-state-${tool}-${Date.now()}`);
  let loop: string | null | undefined;
  for (let i = 0; i < times; i++) loop = chain.recordAndAnalyze(tool, args, clean).loopDetected;
  return loop;
};

describe("live state is declared on the row", () => {
  it("poll: the stateful set the three layers agreed on before", () => {
    expect([...STATEFUL_LIVE_STATE_TOOLS].sort()).toEqual([
      "agent_output", "agent_status", "browser", "camera_capture", "clipboard_read", "computer",
      "op_kill", "op_status", "op_wait", "process_kill", "process_list", "process_restart",
      "process_start", "process_status", "screen_capture", "session_status",
    ]);
  });

  it("fresh: a changing answer is never replayed, poll or not", () => {
    for (const t of ["task_list", "task_get", "tool_search", "request_secret", "request_secrets", "autopilot_status"]) {
      expect(LIVE_STATE_TOOLS.has(t), t).toBe(true);
      expect(STATEFUL_LIVE_STATE_TOOLS.has(t), t).toBe(false);
    }
    for (const t of STATEFUL_LIVE_STATE_TOOLS) expect(LIVE_STATE_TOOLS.has(t), t).toBe(true);
    expect(LIVE_STATE_TOOLS.has("read")).toBe(false);
  });

  it("the loop guard lets a poll repeat and still catches a fresh tool stuck in a loop", () => {
    expect(repeat("op_wait", { id: "op1" }, 13)).toBeFalsy();
    expect(repeat("task_list", {}, 13)).toMatch(/Tool loop detected/);
  });
});

describe("a tool's timeout is declared on the row", () => {
  it("bash above its own 120 s, the long-runners unbounded, the rest on the fallback", () => {
    expect(getToolTimeout("bash")).toBe(130_000);
    for (const t of ["self_edit", "build_app", "op_wait", "agent_spawn", "request_secret", "exit_plan_mode"]) expect(getToolTimeout(t), t).toBe(0);
    expect(getToolTimeout("glob")).toBe(DEFAULT_FALLBACK);
    expect(getToolTimeout("mcp_some_server_tool")).toBe(DEFAULT_FALLBACK);
  });
});
