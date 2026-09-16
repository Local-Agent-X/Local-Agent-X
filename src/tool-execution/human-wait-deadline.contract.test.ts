/**
 * CLASS INVARIANT: a wait for a HUMAN never runs inside a machine deadline
 * unaccounted.
 *
 * The instance that produced it (2026-09-16): browser tool bounded at 30s,
 * approval cards good for 5 minutes, the card raised from inside the tool's
 * own execute. Every sensitive-page action timed out before the user could
 * answer; the model retried; the prompts stacked up. Fixing only the browser
 * would leave the same shape in every other tool that asks — request_secrets,
 * exit_plan_mode, download release, and whatever gets written next.
 *
 * The guarantee is structural, not per-call: tool-runner opens ONE
 * AsyncLocalStorage scope around the execution, the approval manager banks the
 * settled wait into whatever scope is current, and withTimeout re-arms for the
 * excluded remainder. No id is passed, so no call site can key it wrong — the
 * earlier toolCallId-keyed version silently lost the exclusion for any tool
 * without `args._toolCallId` (injected for five tools) or on any
 * `|| "fallback-id"` branch.
 *
 * These tests drive the REAL runner, the REAL approval manager and the REAL
 * timeout, with no knowledge of which tool it is.
 */
import { describe, it, expect, vi } from "vitest";
import type { ToolDefinition, ServerEvent } from "../types.js";
import { createToolRunner } from "./tool-runner.js";
import { setToolTimeout } from "./tool-timeout.js";
import { getApprovalManager } from "../approval-manager.js";
import { currentApprovalWaitMs } from "../approval-wait.js";

/** A tool that asks for approval mid-execute, like the browser gate does. */
function askingTool(name: string, opts: { workMs: number; answerAfterMs: number }): ToolDefinition {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    async execute() {
      const mgr = getApprovalManager();
      let approvalId = "";
      const emit = (e: ServerEvent) => { if (e.type === "approval_requested") approvalId = e.approvalId; };
      const pending = mgr.requestApprovalDetailed({
        toolName: name,
        // Deliberately NOT the dispatch id: a fallback id like the real call
        // sites use must not break the exclusion.
        toolCallId: `fallback-${name}`,
        sessionId: `sess-${name}`,
        context: "sensitive page",
        args: {},
        alwaysAsk: true,
        emit,
      });
      // The human takes their time, then answers.
      await new Promise((r) => setTimeout(r, opts.answerAfterMs));
      mgr.resolveApproval(approvalId, true, false);
      const outcome = await pending;
      if (!outcome.approved) return { content: "declined", isError: true };
      // Then the tool does its own (short) work.
      await new Promise((r) => setTimeout(r, opts.workMs));
      return { content: `did the thing (waited ${currentApprovalWaitMs()}ms on a human)` };
    },
  };
}

function runnerFor(tool: ToolDefinition) {
  return createToolRunner({
    tool,
    args: {},
    toolCallId: `tc-${tool.name}`,
    toolName: tool.name,
    sessionId: `sess-${tool.name}`,
    onProgress: () => {},
  });
}

describe("a human's decision time is not charged to the tool's deadline", () => {
  it("completes when the approval outlives the tool's whole budget", async () => {
    const name = `probe_slow_human_${Date.now()}`;
    setToolTimeout(name, 60);           // the tool may work for 60ms
    const tool = askingTool(name, { workMs: 10, answerAfterMs: 150 }); // human takes 150ms
    const result = await runnerFor(tool).run();
    expect(result.isError).toBeFalsy();
    expect(String(result.content)).toContain("did the thing");
  });

  it("still enforces the deadline on the tool's OWN work after the answer", async () => {
    const name = `probe_slow_tool_${Date.now()}`;
    setToolTimeout(name, 60);
    // Human answers fast; the tool then grinds well past its budget.
    const tool = askingTool(name, { workMs: 400, answerAfterMs: 10 });
    await expect(runnerFor(tool).run()).rejects.toThrow(/timed out/i);
  });

  it("attributes the wait per call — a sibling execution is unaffected", async () => {
    const slow = `probe_sibling_slow_${Date.now()}`;
    const fast = `probe_sibling_fast_${Date.now()}`;
    setToolTimeout(slow, 60);
    setToolTimeout(fast, 60);
    const both = await Promise.allSettled([
      runnerFor(askingTool(slow, { workMs: 10, answerAfterMs: 150 })).run(),
      runnerFor(askingTool(fast, { workMs: 400, answerAfterMs: 10 })).run(),
    ]);
    expect(both[0].status).toBe("fulfilled");   // long human wait, short work
    expect(both[1].status).toBe("rejected");    // short human wait, long work
  });

  it("reads zero outside any tool execution — a pre-dispatch ask is not inside a deadline", () => {
    expect(currentApprovalWaitMs()).toBe(0);
  });
});

describe("the exclusion cannot be keyed wrong", () => {
  it("every approval call site may pass whatever toolCallId it likes", async () => {
    // The tools above pass `fallback-<name>`, never the dispatch id, and the
    // exclusion still holds. This is the property the id-keyed version lacked.
    const name = `probe_any_id_${Date.now()}`;
    setToolTimeout(name, 60);
    const result = await runnerFor(askingTool(name, { workMs: 10, answerAfterMs: 140 })).run();
    expect(String(result.content)).toContain("did the thing");
  });

  it("no tool is required to opt in — the runner opens the scope", async () => {
    const name = `probe_no_optin_${Date.now()}`;
    setToolTimeout(name, 60);
    const seen = vi.fn();
    const tool: ToolDefinition = {
      name,
      description: name,
      parameters: { type: "object", properties: {} },
      async execute() { seen(currentApprovalWaitMs()); return { content: "ok" }; },
    };
    await runnerFor(tool).run();
    // Inside a scope (0ms waited), not undefined and not the process-wide total.
    expect(seen).toHaveBeenCalledWith(0);
  });
});
