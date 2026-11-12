import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCallContext } from "./context.js";
import type { ToolResult } from "../types.js";
import type { KnownFailure } from "../cognition/cross-session-learning/known-failures.js";
import { err, ok } from "../tools/result-helpers.js";
import type { ToolFailureFields } from "./tool-usage-telemetry.js";

const LESSON = "`python3` is not on PATH on this computer; `python` runs the same interpreter.";
const kept = new Map<string, KnownFailure>();
const taken: string[] = [];
const helped: string[] = [];

vi.mock("../cognition/cross-session-learning/known-failures.js", () => ({
  takeLessonFor: (signature: string) => {
    const known = kept.get(signature);
    if (known) taken.push(signature);
    return known;
  },
  noteLessonHelped: (signature: string) => { helped.push(signature); },
}));

const { knownFailureNote, _resetKnownFailureNotes } = await import("./known-failure-note.js");

const failure: ToolFailureFields = { signature: "sig-python", reason: "python3: command not found", opId: "op_1", toolCallId: "c1" };

function ctxWith(result: ToolResult, over: Partial<ToolCallContext> = {}): ToolCallContext {
  return { tc: { id: "c1", name: "bash", arguments: "{}" }, args: {}, callContext: "local", operationId: "op_1", result, ...over } as unknown as ToolCallContext;
}

beforeEach(() => {
  kept.clear(); taken.length = 0; helped.length = 0;
  _resetKnownFailureNotes();
  kept.set("sig-python", {
    signature: "sig-python", tool: "bash", status: "error", reason: "python3: command not found",
    verdict: "lesson", why: "x", lesson: LESSON, state: "kept", sessions: 4, count: 7, reviewedAt: 1, shown: 1, recovered: 0,
  });
});

describe("knownFailureNote", () => {
  it("leads a failed result with the kept lesson, fenced as data", () => {
    const note = knownFailureNote(ctxWith(err("python3: command not found")), failure);
    expect(note).toContain("[Seen before] This call has failed this way in 4 earlier chats on this computer.");
    expect(note).toContain(LESSON);
    expect(note).toContain('untrusted-recalled-data source="known-failure"');
    // The lesson sits inside the fence, after the harness's own sentence.
    expect(note!.indexOf("untrusted-recalled-data")).toBeLessThan(note!.indexOf(LESSON));
  });

  it("says nothing for a failure with no kept lesson, or a call that worked", () => {
    expect(knownFailureNote(ctxWith(err("boom")), { ...failure, signature: "sig-other" })).toBeUndefined();
    expect(knownFailureNote(ctxWith(ok("fine")), undefined)).toBeUndefined();
    expect(taken).toEqual([]);
  });

  it("shows a lesson once per run for the same work", () => {
    expect(knownFailureNote(ctxWith(err("x")), failure)).toBeDefined();
    expect(knownFailureNote(ctxWith(err("x")), failure)).toBeUndefined();
    expect(taken).toEqual(["sig-python"]);
    // Another run meets it new.
    expect(knownFailureNote(ctxWith(err("x"), { operationId: "op_2" }), failure)).toBeDefined();
  });

  it("counts a recovery when the same work then succeeds in that run, once", () => {
    knownFailureNote(ctxWith(err("x")), failure);
    knownFailureNote(ctxWith(ok("fine"), { tc: { id: "c2", name: "read", arguments: "{}" } }), undefined);
    expect(helped).toEqual([]); // a different tool working is not the same work
    knownFailureNote(ctxWith(ok("fine"), { operationId: "op_other" }), undefined);
    expect(helped).toEqual([]); // nor the same tool in another run
    knownFailureNote(ctxWith(ok("report written")), undefined);
    knownFailureNote(ctxWith(ok("again")), undefined);
    expect(helped).toEqual(["sig-python"]);
  });

  it("keys the work on the action of a family tool", () => {
    kept.set("sig-office", { ...kept.get("sig-python")!, signature: "sig-office", tool: "office" });
    const office = { tc: { id: "c1", name: "office", arguments: "{}" }, args: { action: "read" } };
    knownFailureNote(ctxWith(err("x"), office), { ...failure, signature: "sig-office" });
    knownFailureNote(ctxWith(ok("3 sheets"), { ...office, args: { action: "list" } }), undefined);
    expect(helped).toEqual([]);
    knownFailureNote(ctxWith(ok("rows"), office), undefined);
    expect(helped).toEqual(["sig-office"]);
  });

  it("never throws into a tool call", () => {
    kept.set("sig-python", new Proxy({} as KnownFailure, { get() { throw new Error("store is broken"); } }));
    expect(knownFailureNote(ctxWith(err("x")), failure)).toBeUndefined();
  });
});
