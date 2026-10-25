/**
 * A reply the output limit cut off is not an answer.
 *
 * On Terminal-Bench (2026-10-18) a local thinking model wrote ~37k tokens of
 * analysis, hit the context limit with stop "length" and no tool call, and the
 * op ended as a success. These pin the recognition, the bound and the trim.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Op } from "../../ops/types.js";
import type { ToolCall } from "../contract-types.js";

const appendNudgeAsUserMessage = vi.fn(() => true);
vi.mock("./nudges.js", () => ({ appendNudgeAsUserMessage: (...a: unknown[]) => appendNudgeAsUserMessage(...(a as [])) }));

const { CUT_OFF_KEPT_CHARS, CUT_OFF_NUDGE, CUT_OFF_REDRIVE_LIMIT, cutOffRedrivesInARow, evaluateCutOffTurn, isCutOffStop, trimCutOffText } =
  await import("./cut-off-turn.js");
const { _resetMiddlewareStates } = await import("../middlewares/state.js");

const op = { id: "op-cut-off", lane: "interactive" } as unknown as Op;
const call = { toolCallId: "t1", tool: "write", args: {} } as unknown as ToolCall;
const turn = (over: Partial<Parameters<typeof evaluateCutOffTurn>[0]> = {}) => ({
  op, turnIdx: 0, providerStop: "length", toolCalls: [] as ToolCall[], terminalReason: "done" as const,
  middlewareAborted: false, middlewareSuspended: false, ...over,
});

beforeEach(() => { appendNudgeAsUserMessage.mockClear(); _resetMiddlewareStates(); });

describe("isCutOffStop", () => {
  it("is true for each provider's output-limit stop, in any case", () => {
    for (const s of ["length", "max_tokens", "MAX_TOKENS", "max_output_tokens"]) expect(isCutOffStop(s)).toBe(true);
  });

  it("is false for a finished or tool-calling turn, and for no stop at all", () => {
    for (const s of ["stop", "end_turn", "tool_calls", "tool_use", undefined]) expect(isCutOffStop(s)).toBe(false);
  });
});

describe("evaluateCutOffTurn", () => {
  it("re-drives a cut-off turn with no tool call, nudging the model to act", () => {
    expect(evaluateCutOffTurn(turn({ turnIdx: 3 }))).toBe("redrive");
    expect(appendNudgeAsUserMessage).toHaveBeenCalledWith("op-cut-off", 4, CUT_OFF_NUDGE, expect.objectContaining({ name: "cut-off-turn" }));
  });

  it("stops re-driving after the limit and reports it spent", () => {
    for (let i = 0; i < CUT_OFF_REDRIVE_LIMIT; i++) expect(evaluateCutOffTurn(turn({ turnIdx: i }))).toBe("redrive");
    expect(evaluateCutOffTurn(turn({ turnIdx: CUT_OFF_REDRIVE_LIMIT }))).toBe("exhausted");
    expect(appendNudgeAsUserMessage).toHaveBeenCalledTimes(CUT_OFF_REDRIVE_LIMIT);
  });

  it("tells the next turn how many re-drives in a row it follows, back to 0 once a turn acts", () => {
    expect(cutOffRedrivesInARow(op.id)).toBe(0);
    evaluateCutOffTurn(turn());
    expect(cutOffRedrivesInARow(op.id)).toBe(1);
    evaluateCutOffTurn(turn());
    expect(cutOffRedrivesInARow(op.id)).toBe(2);
    evaluateCutOffTurn(turn({ providerStop: "tool_calls", toolCalls: [call] }));
    expect(cutOffRedrivesInARow(op.id)).toBe(0);
  });

  it("counts consecutive cut-offs only: a turn that acts resets the budget", () => {
    for (let i = 0; i < CUT_OFF_REDRIVE_LIMIT; i++) evaluateCutOffTurn(turn());
    expect(evaluateCutOffTurn(turn({ providerStop: "tool_calls", toolCalls: [call] }))).toBeNull();
    expect(evaluateCutOffTurn(turn())).toBe("redrive");
  });

  it("leaves a cut-off turn that made a tool call to the normal loop", () => {
    expect(evaluateCutOffTurn(turn({ toolCalls: [call] }))).toBeNull();
    expect(appendNudgeAsUserMessage).not.toHaveBeenCalled();
  });

  it("never overrides an adapter error, an abort or a suspend", () => {
    expect(evaluateCutOffTurn(turn({ terminalReason: "error" }))).toBeNull();
    expect(evaluateCutOffTurn(turn({ middlewareAborted: true }))).toBeNull();
    expect(evaluateCutOffTurn(turn({ middlewareSuspended: true }))).toBeNull();
    expect(appendNudgeAsUserMessage).not.toHaveBeenCalled();
  });

  // cad-model (2026-10-19): the op's nudge budget was spent, the nudge was
  // refused, and the turn fell through with its full 47k-char draft in history;
  // the next request outgrew the window. The re-drive stands without the nudge.
  it("still re-drives, within the same bound, when the nudge budget is spent", () => {
    appendNudgeAsUserMessage.mockReturnValue(false);
    try {
      for (let i = 0; i < CUT_OFF_REDRIVE_LIMIT; i++) expect(evaluateCutOffTurn(turn({ turnIdx: i }))).toBe("redrive");
      expect(evaluateCutOffTurn(turn({ turnIdx: CUT_OFF_REDRIVE_LIMIT }))).toBe("exhausted");
    } finally {
      appendNudgeAsUserMessage.mockReturnValue(true);
    }
  });
});

describe("trimCutOffText", () => {
  it("keeps a short draft as it is", () => {
    expect(trimCutOffText("Let me write the script.")).toBe("Let me write the script.");
  });

  it("keeps only the marked tail of a runaway draft", () => {
    const draft = "A".repeat(50_000) + "the last step was";
    const kept = trimCutOffText(draft);
    expect(kept.length).toBeLessThan(CUT_OFF_KEPT_CHARS + 200);
    expect(kept.startsWith("[This reply was cut off at the output limit")).toBe(true);
    expect(kept).toContain("Continue by making the next tool call.");
    expect(kept.endsWith("the last step was")).toBe(true);
  });
});
