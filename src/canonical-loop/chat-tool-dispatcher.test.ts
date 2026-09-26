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

// EXP-20: a call by name to a tool the schema does not carry loads it the way
// a tool_search hit is loaded, then dispatches; an unknown name still gets the
// corrective. Reach equals tool_search's — no new capability, one fewer round.
describe("a tool called by name that the schema does not carry", () => {
  beforeAll(() => setAriRequired(false));
  afterAll(() => setAriRequired(true));

  it("is loaded from the registry and executed; an unknown name is still refused with the corrective", async () => {
    const { unifiedRegistry } = await import("../tools/registry.js");
    const calls = { n: 0 };
    const echo = echoTool(calls);
    unifiedRegistry.register(echo);
    try {
      const dispatcher = makeChatToolDispatcher({
        tools: [],                       // the schema carries nothing
        security: undefined as never,
        sessionId: "s-byname",
        callContext: "local",
        opId: freshOpId(),
      });
      const res = await dispatcher.dispatch({ toolCallId: "call-byname", tool: "echo", args: { v: 7 } });
      const text = typeof res.result === "string" ? res.result : JSON.stringify(res.result);
      expect(text).toContain("FRESH");
      expect(calls.n).toBe(1);

      const unknown = await dispatcher.dispatch({ toolCallId: "call-unknown", tool: "echoo", args: {} });
      const utext = typeof unknown.result === "string" ? unknown.result : JSON.stringify(unknown.result);
      expect(utext).toMatch(/Unknown tool "echoo"/);
      expect(calls.n).toBe(1);
    } finally {
      unifiedRegistry._resetForTesting();
    }
  });
});

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

// A second station's session (2026-09-26): the model called `switch_tab` — an
// action of `browser` — as a tool. The kernel ran before the unknown-tool check, so
// the model was told "not in TOOL_CLASS_MAP — classify it … app bug", and the
// agent reviewing the session concluded the browser's tab actions were unmapped.
// The kernel stays REQUIRED here (the default), as in the product.
describe("a name that is not a tool is refused before the kernel", () => {
  const browserLike = {
    name: "browser",
    description: "",
    parameters: { type: "object", properties: { action: { type: "string", enum: ["navigate", "tabs", "switch_tab"] } } },
    execute: async (): Promise<ToolResult> => ({ content: "ran", isError: false }),
  } as unknown as ToolDefinition;

  const dispatchText = async (tool: string) => {
    const dispatcher = makeChatToolDispatcher({
      tools: [browserLike], security: undefined as never, sessionId: "s-unknown-first", callContext: "local", opId: freshOpId(),
    });
    const res = await dispatcher.dispatch({ toolCallId: `call-${tool}`, tool, args: {} });
    return typeof res.result === "string" ? res.result : JSON.stringify(res.result);
  };

  it("an action called as a tool is pointed at the tool that owns it, with no kernel text", async () => {
    const text = await dispatchText("switch_tab");
    expect(text).toContain('call browser with action="switch_tab"');
    expect(text).not.toMatch(/ARI kernel|TOOL_CLASS_MAP/);
  });

  it("any other unknown name gets the list of real tool names, with no kernel text", async () => {
    const text = await dispatchText("open_tab_now");
    expect(text).toMatch(/Unknown tool "open_tab_now"|Tool name typo/);
    expect(text).not.toMatch(/ARI kernel|TOOL_CLASS_MAP/);
  });
});
