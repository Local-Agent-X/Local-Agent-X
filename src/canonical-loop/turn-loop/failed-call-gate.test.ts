// A request may not end on a failed tool call without one more real attempt
// (2026-10-03: a Codex turn handed work back to the user after one failed
// call). The gate reads the tool results, not the model's wording, and never
// fires on a policy outcome: pushing for "another way" past a security block
// or the user's "no" would steer around the guard.
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ turns: [] as Array<{ turnIdx: number; toolCallSummary: Array<{ tool: string; resultStatus: string }> }> }));
vi.mock("../store.js", () => ({ readOpTurns: () => store.turns }));
vi.mock("./nudges.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./nudges.js")>()),
  appendNudgeAsUserMessage: vi.fn(() => true),
}));

import { runFailedCallGate, failedCallNudge } from "./failed-call-gate.js";
import { COMPLETION_GATES } from "./decide-outcome-gates.js";
import { appendNudgeAsUserMessage } from "./nudges.js";
import type { CompletionGateContext } from "./decide-outcome-gate-contract.js";
import type { Op } from "../../ops/types.js";
import type { ToolCallSummary } from "../types.js";

let n = 0;
function ctx(toolSummary: Array<{ tool: string; resultStatus: string }>, turnIdx = 1): CompletionGateContext {
  return {
    op: { id: `op-failed-call-${n++}` } as Op,
    turnIdx,
    toolCalls: [],
    assistantText: "I couldn't open it. Send me a screenshot of the profile and I'll check it.",
    toolSummary: toolSummary as ToolCallSummary[],
  };
}
const call = (tool: string, resultStatus: string) => ({ tool, resultStatus, argsHash: "h", durationMs: 1 });

beforeEach(() => {
  store.turns = [];
  vi.mocked(appendNudgeAsUserMessage).mockClear();
});

describe("a request ending on a failed call", () => {
  it("reopens once when the failure was in an earlier turn and this turn is the handoff", () => {
    store.turns = [{ turnIdx: 0, toolCallSummary: [call("browser", "error")] }];
    expect(runFailedCallGate(ctx([]))).toEqual({ shouldRetry: true, nudge: failedCallNudge("browser") });
  });

  it("reopens when this turn's own last call failed, and on a timeout", () => {
    expect(runFailedCallGate(ctx([call("browser", "ok"), call("browser", "error")])).shouldRetry).toBe(true);
    expect(runFailedCallGate(ctx([call("web_fetch", "timeout")])).shouldRetry).toBe(true);
  });

  it("fires once per request: a second failure ends the turn as the model chose", () => {
    const c = ctx([call("browser", "error")]);
    expect(runFailedCallGate(c).shouldRetry).toBe(true);
    expect(runFailedCallGate(c).shouldRetry).toBe(false);
  });

  it("the note names the tool, asks for another way or an exact handoff, and forbids repeating it unchanged", () => {
    const nudge = failedCallNudge("browser");
    expect(nudge).toContain("`browser`");
    expect(nudge).toMatch(/try another way/);
    expect(nudge).toMatch(/if its result says it needs the user, tell them exactly what/);
    expect(nudge).toMatch(/Do not repeat the same call unchanged/);
  });
});

describe("what never fires it", () => {
  it("a policy outcome: a security block or the user declining is a decision, not a detour", () => {
    expect(runFailedCallGate(ctx([call("browser", "blocked")])).shouldRetry).toBe(false);
    expect(runFailedCallGate(ctx([call("setting", "declined")])).shouldRetry).toBe(false);
    store.turns = [{ turnIdx: 0, toolCallSummary: [call("http_request", "blocked")] }];
    expect(runFailedCallGate(ctx([])).shouldRetry).toBe(false);
  });

  it("a failure something later succeeded past, or a request with no tool calls", () => {
    store.turns = [{ turnIdx: 0, toolCallSummary: [call("browser", "error")] }, { turnIdx: 1, toolCallSummary: [call("browser", "ok")] }];
    expect(runFailedCallGate(ctx([], 2)).shouldRetry).toBe(false);
    store.turns = [];
    expect(runFailedCallGate(ctx([])).shouldRetry).toBe(false);
  });

  it("a cancelled call", () => {
    expect(runFailedCallGate(ctx([call("bash", "cancelled")])).shouldRetry).toBe(false);
  });
});

describe("in the completion chain", () => {
  it("reopens the turn and appends the note for the next turn", async () => {
    const gate = COMPLETION_GATES.find((g) => g.name === "failed-call")!;
    store.turns = [{ turnIdx: 0, toolCallSummary: [call("browser", "error")] }];
    const c = ctx([]);
    const out = await gate.evaluate(c);
    expect(out.reopen).toBe(true);
    expect(appendNudgeAsUserMessage).toHaveBeenCalledWith(c.op.id, c.turnIdx + 1, failedCallNudge("browser"), expect.objectContaining({ name: "failed-call", outcome: "nudge" }));
  });
});
