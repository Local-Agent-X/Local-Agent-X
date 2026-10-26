/**
 * Tool output from finished turns is stubbed in the model's view; the newest
 * finished turn and every user and assistant row stay verbatim, the view is a
 * pure function of the history, and the transcript is untouched.
 */
import { describe, it, expect } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { markHarnessRow } from "../harness-rows.js";
import { PRUNED_RESULT_KEEP_CHARS } from "./compaction-policy.js";
import { lastTurnStart, pruneFinishedTurnToolResults } from "./prune-tool-results.js";
import { totalTokens } from "./token-estimation.js";

const user = (text: string): ChatCompletionMessageParam => ({ role: "user", content: text });
const assistant = (text: string): ChatCompletionMessageParam => ({ role: "assistant", content: text });
const call = (id: string, name: string): ChatCompletionMessageParam =>
  ({ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }] } as ChatCompletionMessageParam);
const result = (id: string, text: string): ChatCompletionMessageParam => ({ role: "tool", tool_call_id: id, content: text });

const dump = "x".repeat(20_000);

/** Two finished turns, each a read then an answer. */
function twoTurns(): ChatCompletionMessageParam[] {
  return [
    user("show me the config"),
    call("c1", "read"), result("c1", dump),
    assistant("here it is"),
    user("now the tests"),
    call("c2", "grep"), result("c2", dump),
    assistant("found three"),
  ];
}

describe("pruneFinishedTurnToolResults", () => {
  it("stubs tool results from turns before the last one and keeps everything else verbatim", () => {
    const history = twoTurns();
    const view = pruneFinishedTurnToolResults(history);
    expect(view).toHaveLength(history.length);
    expect(String(view[2].content)).toMatch(/^\[earlier tool result elided — read, 20000 chars/);
    expect(view[6]).toBe(history[6]); // the newest finished turn's read is kept whole
    for (const i of [0, 1, 3, 4, 5, 7]) expect(view[i]).toBe(history[i]);
    expect(history[2].content).toBe(dump); // the transcript itself is untouched
    // One of the two dumps is gone from the view.
    expect(totalTokens(view)).toBeLessThan(totalTokens(history) - 5_000);
  });

  it("leaves short results alone — an error line is worth more than its stub", () => {
    const history = twoTurns();
    history[2] = result("c1", "ENOENT: no such file");
    const view = pruneFinishedTurnToolResults(history);
    expect(view).toBe(history);
    expect("x".repeat(PRUNED_RESULT_KEEP_CHARS).length).toBe(PRUNED_RESULT_KEEP_CHARS);
  });

  it("a conversation with one turn, or none, is returned as is", () => {
    const one = twoTurns().slice(0, 4);
    expect(pruneFinishedTurnToolResults(one)).toBe(one);
    expect(pruneFinishedTurnToolResults([])).toEqual([]);
  });

  it("a harness row is not a turn boundary", () => {
    const history = twoTurns();
    history.push(markHarnessRow(user("[nudge] keep going"), "nudge"), call("c3", "read"), result("c3", dump));
    expect(lastTurnStart(history)).toBe(4);
    const view = pruneFinishedTurnToolResults(history);
    expect(view[6]).toBe(history[6]);
    expect(view[10]).toBe(history[10]);
    expect(String(view[2].content)).toContain("elided");
  });

  it("the view is a pure function of the history: message N's view is a prefix of message N+1's up to the boundary", () => {
    const history = twoTurns();
    const before = pruneFinishedTurnToolResults(history);
    const longer = [...history, user("and the readme"), call("c3", "read"), result("c3", dump), assistant("done")];
    const after = pruneFinishedTurnToolResults(longer);
    // Everything before the previous boundary (index 4) is byte-identical.
    expect(JSON.stringify(after.slice(0, 4))).toBe(JSON.stringify(before.slice(0, 4)));
    // The turn that just finished is what changed, once.
    expect(String(after[6].content)).toContain("elided");
    expect(after[10]).toBe(longer[10]);
  });
});
