// A reply the local output cap cut off is continued from where it stopped:
// the cut reply goes back as a trailing assistant row (Ollama renders it as a
// prefill), its thinking closed, and the next leg acts on it or finishes the
// text. TB2 db-wal-recovery (2026-10-29): one 88,825-token thought ate 11 of
// the task's 15 minutes; under a cap with no continuation the same model
// re-derived from scratch each time (adaptive-rejection-sampler, 10-27).
import { describe, expect, it, vi } from "vitest";
import type { ProviderRequest } from "../../../providers/adapter/types.js";
import {
  CUT_OFF_CONTINUATION_LEGS,
  THINKING_BUDGET_CLOSE,
  continuationRow,
  continueCutOffReply,
  isContinuableCut,
  mergeLeg,
} from "./cut-off-continuation.js";
import type { StreamOnceResult } from "./types.js";

function reply(over: Partial<StreamOnceResult> = {}): StreamOnceResult {
  return {
    assembledText: "", assembledThinking: "", pendingToolCalls: [], firstError: null,
    providerStop: "length", usagePromptTokens: 1_000, usageCompletionTokens: 16_384, interruptedByInject: false, ...over,
  };
}
const cutWhileThinking = (thinking = "Let me derive the key: 0x42 because") => reply({ assembledThinking: thinking });
const cutWhileWriting = () => reply({ assembledThinking: "plan", assembledText: "The key is 0x42 and the fix" });
const toolCall = { id: "c1", name: "bash", arguments: "{}" };
const req = { model: "qwen3.8:27b", messages: [{ role: "user", content: "fix the WAL" }], maxTokens: 16_384 } as unknown as ProviderRequest;

describe("isContinuableCut", () => {
  it("is a reply the cap cut with something to continue from", () => {
    expect(isContinuableCut(cutWhileThinking())).toBe(true);
    expect(isContinuableCut(cutWhileWriting())).toBe(true);
    expect(isContinuableCut(reply({ providerStop: "max_tokens", assembledText: "x" }))).toBe(true);
  });

  it("is not a finished reply, a tool call, an error, a guard stop, an interrupt, or a cut with nothing in it", () => {
    expect(isContinuableCut(reply({ providerStop: "stop", assembledText: "done" }))).toBe(false);
    expect(isContinuableCut(reply({ pendingToolCalls: [toolCall], assembledThinking: "t" }))).toBe(false);
    expect(isContinuableCut(reply({ assembledThinking: "t", firstError: { code: "x", message: "y" } }))).toBe(false);
    expect(isContinuableCut(reply({ assembledThinking: "t", stoppedByGuard: "loop" }))).toBe(false);
    expect(isContinuableCut(reply({ assembledThinking: "t", interruptedByInject: true }))).toBe(false);
    expect(isContinuableCut(reply())).toBe(false);
  });
});

describe("continuationRow", () => {
  it("a thought cut mid-way goes back closed, with Qwen's budget sentence, and no text to continue", () => {
    expect(continuationRow({ thinking: "half a derivation", text: "" })).toEqual({
      role: "assistant", content: "", reasoning: `half a derivation\n\n${THINKING_BUDGET_CLOSE}`,
    });
  });

  it("text cut mid-sentence goes back as the row's content, its thinking as it was", () => {
    expect(continuationRow({ thinking: "plan", text: "The key is 0x42 and the fix" })).toEqual({
      role: "assistant", content: "The key is 0x42 and the fix", reasoning: "plan",
    });
    expect(continuationRow({ thinking: "", text: "partial" })).toEqual({ role: "assistant", content: "partial" });
  });
});

describe("mergeLeg", () => {
  it("joins the texts and the thinking; the leg's stop, calls and prompt usage stand, output is summed", () => {
    const merged = mergeLeg(
      reply({ assembledThinking: "T1", usageCompletionTokens: 16_384, firstTokenMs: 250 }),
      reply({ assembledThinking: "T2", assembledText: "answer", pendingToolCalls: [toolCall], providerStop: "tool_calls", usagePromptTokens: 17_500, usageCompletionTokens: 300, firstTokenMs: 40 }),
    );
    expect(merged).toMatchObject({
      assembledThinking: "T1\n\nT2", assembledText: "answer", rawText: "answer", pendingToolCalls: [toolCall],
      providerStop: "tool_calls", usagePromptTokens: 17_500, usageCompletionTokens: 16_684, firstTokenMs: 250,
    });
    expect(mergeLeg(cutWhileWriting(), reply({ assembledText: " is to XOR it.", providerStop: "stop" })).assembledText)
      .toBe("The key is 0x42 and the fix is to XOR it.");
  });
});

describe("continueCutOffReply", () => {
  const cap = vi.fn((_added: number) => 16_384);
  const leg = (r: StreamOnceResult) => vi.fn(async (_req: ProviderRequest) => r);

  it("sends the cut reply back as the last row and takes the leg's action as the turn's", async () => {
    const run = leg(reply({ pendingToolCalls: [toolCall], providerStop: "tool_calls", usageCompletionTokens: 120 }));
    const { result, legs } = await continueCutOffReply({ req, result: cutWhileThinking("T1"), cap, run, isAborted: () => false });
    expect(legs).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
    const sent = run.mock.calls[0][0] as ProviderRequest;
    expect(sent.messages.at(-1)).toEqual({ role: "assistant", content: "", reasoning: `T1\n\n${THINKING_BUDGET_CLOSE}` });
    expect(sent.messages).toHaveLength(2);
    expect(sent.maxTokens).toBe(16_384);
    expect(result.pendingToolCalls).toEqual([toolCall]);
    expect(result.assembledThinking).toBe("T1");
    expect(result.usageCompletionTokens).toBe(16_504);
  });

  it("continues cut text mid-sentence until the reply finishes", async () => {
    const run = leg(reply({ assembledText: " is to XOR every byte.", providerStop: "stop" }));
    const { result, legs } = await continueCutOffReply({ req, result: cutWhileWriting(), cap, run, isAborted: () => false });
    expect(legs).toBe(1);
    expect((run.mock.calls[0][0] as ProviderRequest).messages.at(-1)).toEqual({ role: "assistant", content: "The key is 0x42 and the fix", reasoning: "plan" });
    expect(result.assembledText).toBe("The key is 0x42 and the fix is to XOR every byte.");
    expect(result.providerStop).toBe("stop");
  });

  it("stops after CUT_OFF_CONTINUATION_LEGS legs still cut, leaving the turn loop's re-drive the rest", async () => {
    const run = leg(cutWhileThinking("more"));
    const { result, legs } = await continueCutOffReply({ req, result: cutWhileThinking("T1"), cap, run, isAborted: () => false });
    expect(legs).toBe(CUT_OFF_CONTINUATION_LEGS);
    expect(run).toHaveBeenCalledTimes(CUT_OFF_CONTINUATION_LEGS);
    expect(result.providerStop).toBe("length");
    expect(result.assembledThinking).toBe("T1\n\nmore\n\nmore");
    // Each later leg carries everything so far, the closing sentence once, at the end.
    const last = (run.mock.calls[1][0] as ProviderRequest).messages.at(-1) as unknown as { reasoning: string };
    expect(last.reasoning).toBe(`T1\n\nmore\n\n${THINKING_BUDGET_CLOSE}`);
  });

  it("sizes each leg's cap for the prompt the carried reply adds, and stops when the window has no room", async () => {
    const run = leg(cutWhileThinking("x"));
    const tight = vi.fn((added: number) => (added > 10 ? undefined : 16_384));
    const { legs } = await continueCutOffReply({ req, result: cutWhileThinking("t".repeat(1_000)), cap: tight, run, isAborted: () => false });
    expect(legs).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(tight).toHaveBeenCalledWith(Math.ceil(1_000 / 3.5));
  });

  it("leaves a finished reply, and an aborted turn, alone", async () => {
    const run = leg(cutWhileThinking("never"));
    const finished = reply({ assembledText: "done", providerStop: "stop" });
    expect(await continueCutOffReply({ req, result: finished, cap, run, isAborted: () => false })).toEqual({ result: finished, legs: 0 });
    expect(await continueCutOffReply({ req, result: cutWhileThinking(), cap, run, isAborted: () => true })).toMatchObject({ legs: 0 });
    expect(run).not.toHaveBeenCalled();
  });
});
