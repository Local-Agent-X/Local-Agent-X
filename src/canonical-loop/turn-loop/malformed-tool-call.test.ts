/**
 * A tool call the runtime could not parse ran nothing.
 *
 * On Terminal-Bench 2.0 (2026-10-23) Ollama failed two Qwen responses with
 * "XML syntax error on line 4: element <function> closed by </parameter>" and
 * the op ended on the transport error, one step from the answer. These pin the
 * recognition, the re-drive and its bound.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Op } from "../../ops/types.js";
import type { ToolCall } from "../contract-types.js";

const appendNudgeAsUserMessage = vi.fn(() => true);
vi.mock("./nudges.js", () => ({ appendNudgeAsUserMessage: (...a: unknown[]) => appendNudgeAsUserMessage(...(a as [])) }));

const { MALFORMED_TOOL_CALL_REDRIVE_LIMIT, evaluateMalformedToolCall } = await import("./malformed-tool-call.js");
const { _resetMiddlewareStates } = await import("../middlewares/state.js");
const { classify } = await import("../../resilience-policy.js");

const OLLAMA_QWEN = "XML syntax error on line 4: element <function> closed by </parameter>";
const op = { id: "op-malformed", lane: "interactive" } as unknown as Op;
const call = { toolCallId: "t1", tool: "bash", args: {} } as unknown as ToolCall;
const turn = (over: Partial<Parameters<typeof evaluateMalformedToolCall>[0]> = {}) => ({
  op, turnIdx: 0, adapterError: { code: "transport_error", message: OLLAMA_QWEN },
  toolCalls: [] as ToolCall[], middlewareAborted: false, middlewareSuspended: false, ...over,
});

beforeEach(() => { appendNudgeAsUserMessage.mockClear(); _resetMiddlewareStates(); });

describe("classify — malformedToolCall", () => {
  it("recognizes each runtime's tool-call parse failure", () => {
    for (const m of [
      OLLAMA_QWEN,
      "Failed to parse tool call arguments as JSON",
      "error parsing tool call: unexpected end of input",
      "tool call could not be parsed",
      "function_call arguments are malformed",
    ]) expect(classify(m), m).toBe("malformedToolCall");
  });

  it("leaves other provider failures in their own category", () => {
    expect(classify("503 Service Unavailable")).toBe("overload");
    expect(classify("request (65541 tokens) exceeds the available context size")).toBe("contextOverflow");
    expect(classify("tool not found: frobnicate")).toBe("tool");
  });
});

describe("evaluateMalformedToolCall", () => {
  it("re-drives the turn and tells the model nothing ran, quoting the parse error", () => {
    expect(evaluateMalformedToolCall(turn({ turnIdx: 4 }))).toBe("redrive");
    const [, nextTurn, text] = appendNudgeAsUserMessage.mock.calls[0] as unknown as [string, number, string];
    expect(nextTurn).toBe(5);
    expect(text).toMatch(/could not be parsed .*nothing ran/);
    expect(text).toContain("XML syntax error");
    expect(text).toMatch(/native tool-call format/);
  });

  it("stops re-driving after the limit and leaves the error standing", () => {
    for (let i = 0; i < MALFORMED_TOOL_CALL_REDRIVE_LIMIT; i++) expect(evaluateMalformedToolCall(turn({ turnIdx: i }))).toBe("redrive");
    expect(evaluateMalformedToolCall(turn())).toBe("exhausted");
  });

  it("counts consecutive failures only: a clean turn resets the budget", () => {
    evaluateMalformedToolCall(turn());
    evaluateMalformedToolCall(turn({ adapterError: null }));
    for (let i = 0; i < MALFORMED_TOOL_CALL_REDRIVE_LIMIT; i++) expect(evaluateMalformedToolCall(turn())).toBe("redrive");
  });

  it("ignores any other adapter error, a turn whose calls did parse, and an abort or suspend", () => {
    expect(evaluateMalformedToolCall(turn({ adapterError: { code: "transport_error", message: "socket hang up" } }))).toBeNull();
    expect(evaluateMalformedToolCall(turn({ toolCalls: [call] }))).toBeNull();
    expect(evaluateMalformedToolCall(turn({ middlewareAborted: true }))).toBeNull();
    expect(evaluateMalformedToolCall(turn({ middlewareSuspended: true }))).toBeNull();
    expect(appendNudgeAsUserMessage).not.toHaveBeenCalled();
  });
});
