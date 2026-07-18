// Regression for the theme-5 finding "self_edit intent gate fails OPEN —
// priorMessages never wired". makeChatToolDispatcher used to pass
// `priorMessages: undefined` into executeToolCalls, so every canonical-path
// resolve-phase guard that reads prior turns (self_edit's intent gate AND the
// session-repeat dedup) ran against an empty array and silently failed open.
//
// The fix reads the op's persisted messages (via the canonical
// opMessageRowToChatParam adapter) on each dispatch. This test proves the wire
// end-to-end through the dedup guard: a persisted prior identical tool call +
// result must short-circuit an identical re-dispatch WITHOUT re-executing the
// tool. If someone reverts the wiring to `undefined`, the tool re-runs and this
// fails.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeChatToolDispatcher } from "./chat-tool-dispatcher.js";
import { appendOpMessage } from "./store.js";
import { setAriRequired } from "../ari-kernel/state.js";
import type { OpMessageRow } from "./types.js";
import type { ToolDefinition, ToolResult } from "../types.js";

let seq = 0;
function freshOpId(): string { return `op_dispatcher_test_${seq++}_${process.pid}`; }

/** A tool that records how many times it actually executes. */
function echoTool(calls: { n: number }): ToolDefinition {
  return {
    name: "echo",
    description: "",
    parameters: { type: "object", properties: { v: { type: "number" } } },
    execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
      calls.n++;
      return { content: `FRESH:${JSON.stringify(args)}`, isError: false };
    },
  } as unknown as ToolDefinition;
}

function seedPriorCall(opId: string, argsJson: string, resultText: string): void {
  // Assistant turn that issued the tool call...
  appendOpMessage({
    messageId: "m-assistant", opId, turnIdx: 0, seqInTurn: 0,
    role: "assistant",
    content: { text: "", toolCalls: [{ id: "prior-1", name: "echo", arguments: argsJson }] },
    createdAt: new Date(0).toISOString(),
  } as OpMessageRow);
  // ...and the tool result it produced.
  appendOpMessage({
    messageId: "m-tool", opId, turnIdx: 0, seqInTurn: 1,
    role: "tool_result",
    content: { toolCallId: "prior-1", result: resultText, status: "ok" },
    createdAt: new Date(0).toISOString(),
  } as OpMessageRow);
}

describe("makeChatToolDispatcher wires priorMessages from op storage", () => {
  beforeAll(() => setAriRequired(false));
  afterAll(() => setAriRequired(true));

  it("dedups an identical re-dispatch against a persisted prior call — tool does NOT re-run", async () => {
    const opId = freshOpId();
    seedPriorCall(opId, JSON.stringify({ v: 1 }), "PRIOR_RESULT");

    const calls = { n: 0 };
    const dispatcher = makeChatToolDispatcher({
      tools: [echoTool(calls)],
      security: undefined as never,
      sessionId: "s-dedup",
      callContext: "local",
      opId,
    });

    const res = await dispatcher.dispatch({ toolCallId: "call-2", tool: "echo", args: { v: 1 } });

    const text = typeof res.result === "string" ? res.result : JSON.stringify(res.result);
    expect(text).toContain("[REPEATED CALL");
    expect(text).toContain("PRIOR_RESULT");
    expect(calls.n).toBe(0); // proves priorMessages reached the dedup guard
  });

  it("does NOT dedup a call with different args — tool runs (control)", async () => {
    const opId = freshOpId();
    seedPriorCall(opId, JSON.stringify({ v: 1 }), "PRIOR_RESULT");

    const calls = { n: 0 };
    const dispatcher = makeChatToolDispatcher({
      tools: [echoTool(calls)],
      security: undefined as never,
      sessionId: "s-control",
      callContext: "local",
      opId,
    });

    const res = await dispatcher.dispatch({ toolCallId: "call-3", tool: "echo", args: { v: 2 } });

    const text = typeof res.result === "string" ? res.result : JSON.stringify(res.result);
    expect(text).toContain("FRESH");
    expect(calls.n).toBe(1);
  });

  it("re-executes an identical call after a prior error so recovery can run", async () => {
    const opId = freshOpId();
    seedPriorCall(opId, JSON.stringify({ v: 1 }), "[error]\ntransient bridge timeout");

    const calls = { n: 0 };
    const dispatcher = makeChatToolDispatcher({
      tools: [echoTool(calls)],
      security: undefined as never,
      sessionId: "s-error-retry",
      callContext: "local",
      opId,
    });

    const res = await dispatcher.dispatch({ toolCallId: "call-retry", tool: "echo", args: { v: 1 } });

    const text = typeof res.result === "string" ? res.result : JSON.stringify(res.result);
    expect(text).toContain("FRESH");
    expect(text).not.toContain("[REPEATED CALL");
    expect(calls.n).toBe(1);
  });
});
