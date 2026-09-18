/**
 * "Let me search the workspace for it." — and nothing happened.
 *
 * muse ended an op (op-outcomes find-project) on that single sentence: one
 * round, zero tool calls. The turn looked finished to the done gate (tool-less
 * turn with assistant text), so the user was handed a promise instead of an
 * answer. Same class as the reasoning-only stall (H-024), with the plan
 * arriving as answer text rather than as reasoning.
 *
 * The rule has to be hard to trip: a genuinely finished answer may say "I'll"
 * ("I'll leave everything in cleanup/legacy untouched" is a complete reply).
 * These pin what fires and, more importantly, what does not.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Op } from "../../ops/types.js";
import type { ToolCall } from "../contract-types.js";

const appendNudgeAsUserMessage = vi.fn(() => true);
vi.mock("./nudges.js", () => ({ appendNudgeAsUserMessage: (...a: unknown[]) => appendNudgeAsUserMessage(...(a as [])) }));

const { isAnnouncedOnlyReply, redriveAnnouncedOnlyTurn } = await import("./empty-turn-termination.js");
const { clearMiddlewareStateForOp } = await import("../middlewares/state.js");

let nextOp = 0;
function op(lane: Op["lane"] = "interactive"): Op {
  return { id: `op-announced-${nextOp++}`, lane } as unknown as Op;
}
const call = (tool: string): ToolCall => ({ id: "t1", tool, args: {} } as unknown as ToolCall);

beforeEach(() => appendNudgeAsUserMessage.mockClear());

describe("isAnnouncedOnlyReply", () => {
  it("is true for the reply that ended find-project", () => {
    expect(isAnnouncedOnlyReply("Let me search the workspace for it.")).toBe(true);
  });

  it("is true for other bare announcements", () => {
    expect(isAnnouncedOnlyReply("I'll go find that file now.")).toBe(true);
    expect(isAnnouncedOnlyReply("I'm going to check the logs.")).toBe(true);
  });

  it("is false when the model is asking the user", () => {
    expect(isAnnouncedOnlyReply("Sure, I'll take a look — which project do you mean?")).toBe(false);
  });

  it("is false for a closer that promises nothing on-task", () => {
    expect(isAnnouncedOnlyReply("Done. Let me know if you want anything else.")).toBe(false);
  });

  it("is false for a substantive answer that happens to say I'll", () => {
    const answer =
      "Got it — I'll leave everything in cleanup/legacy untouched. It's archived client work, " +
      "so no edits or deletes there. Everything else in the workspace is fair game, and the " +
      "three .tmp files under cleanup/build and cleanup/cache are the ones I would remove.";
    expect(isAnnouncedOnlyReply(answer)).toBe(false);
  });

  it("is false for empty text", () => {
    expect(isAnnouncedOnlyReply("   ")).toBe(false);
  });
});

describe("redriveAnnouncedOnlyTurn", () => {
  it("nudges once, then never again in the same op", () => {
    const o = op();
    expect(redriveAnnouncedOnlyTurn({ op: o, turnIdx: 0, assistantText: "Let me search the workspace.", toolCalls: [] })).toBe(true);
    expect(redriveAnnouncedOnlyTurn({ op: o, turnIdx: 1, assistantText: "Let me search the workspace.", toolCalls: [] })).toBe(false);
    expect(appendNudgeAsUserMessage).toHaveBeenCalledTimes(1);
    clearMiddlewareStateForOp(o.id);
  });

  it("never fires once the op has dispatched a tool — a pause mid-work is not a stall", () => {
    const o = op();
    expect(redriveAnnouncedOnlyTurn({ op: o, turnIdx: 0, assistantText: "Reading the file.", toolCalls: [call("read")] })).toBe(false);
    expect(redriveAnnouncedOnlyTurn({ op: o, turnIdx: 1, assistantText: "Let me check the other one.", toolCalls: [] })).toBe(false);
    expect(appendNudgeAsUserMessage).not.toHaveBeenCalled();
    clearMiddlewareStateForOp(o.id);
  });

  it("leaves worker lanes alone — they have their own empty-response nudge", () => {
    const o = op("build" as Op["lane"]);
    expect(redriveAnnouncedOnlyTurn({ op: o, turnIdx: 0, assistantText: "Let me search the workspace.", toolCalls: [] })).toBe(false);
    clearMiddlewareStateForOp(o.id);
  });

  it("reports no re-drive when the nudge budget refuses it", () => {
    appendNudgeAsUserMessage.mockReturnValueOnce(false);
    const o = op();
    expect(redriveAnnouncedOnlyTurn({ op: o, turnIdx: 0, assistantText: "Let me search the workspace.", toolCalls: [] })).toBe(false);
    clearMiddlewareStateForOp(o.id);
  });
});
