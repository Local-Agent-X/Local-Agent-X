import { describe, it, expect } from "vitest";
import { broadSweepNudgeMiddleware, looksLikeBroadSweep } from "./broad-sweep-nudge.js";
import type { CanonicalLoopContext } from "./types.js";

let _op = 0;
function opId(): string { return `op-bsn-test-${++_op}`; }

function ctxFor(
  op: string,
  opts: { task: string; toolCalls?: number; enumeratedThisOp?: boolean },
): CanonicalLoopContext {
  return {
    op: { id: op },
    userMessage: opts.task,
    assistantContent: "",
    toolCalls: new Array(opts.toolCalls ?? 0).fill({ name: "x" }),
    toolsCalledThisOp: new Set(opts.enumeratedThisOp ? ["grep"] : []),
  } as unknown as CanonicalLoopContext;
}

const run = (op: string, opts: Parameters<typeof ctxFor>[1]) =>
  broadSweepNudgeMiddleware.afterModelCall!(ctxFor(op, opts));

// The first is the exact task the three models ran in the live comparison.
const SWEEPS = [
  "We switched this app off Tailscale. There are still out-of-date tailnet references left over in the code — go through the project and finish cleaning them up.",
  "Find and fix all occurrences of the old API name across the codebase.",
  "Remove every reference to the deprecated flag throughout the project.",
  "Rename getUser to fetchUser everywhere.",
  "Migrate the whole codebase off moment.js.",
  "Clean up all the dead imports in the repo.",
];

const NARROW = [
  "Fix the typo in README.md.",
  "Add a logout button to the settings page.",
  "What's the capital of France?",
  "Update the version number in package.json.",
  "Remove the unused import in bar.ts.",
  "Summarize all the key points in this document.",
  "List all the files in src.",
];

describe("looksLikeBroadSweep", () => {
  it("fires on codebase-wide find-and-change tasks", () => {
    for (const t of SWEEPS) expect(looksLikeBroadSweep(t), t).toBe(true);
  });
  it("does NOT fire on narrow / single-spot / read-only tasks", () => {
    for (const t of NARROW) expect(looksLikeBroadSweep(t), t).toBe(false);
  });
  it("ignores trivially short input", () => {
    expect(looksLikeBroadSweep("fix all")).toBe(false);
    expect(looksLikeBroadSweep("")).toBe(false);
  });
});

describe("broadSweepNudgeMiddleware", () => {
  it("nudges a sweep that wraps up without enumerating", () => {
    const r = run(opId(), { task: SWEEPS[0], toolCalls: 0, enumeratedThisOp: false });
    expect(r).toMatchObject({ kind: "nudge", reason: "broad-sweep-enumerate" });
  });
  it("stays quiet once the op has grep/glob'd", () => {
    expect(run(opId(), { task: SWEEPS[0], toolCalls: 0, enumeratedThisOp: true }))
      .toEqual({ kind: "continue" });
  });
  it("stays quiet while the model is still calling tools this turn", () => {
    expect(run(opId(), { task: SWEEPS[0], toolCalls: 2, enumeratedThisOp: false }))
      .toEqual({ kind: "continue" });
  });
  it("stays quiet on a narrow task", () => {
    expect(run(opId(), { task: NARROW[0], toolCalls: 0, enumeratedThisOp: false }))
      .toEqual({ kind: "continue" });
  });
  it("fires at most once per op", () => {
    const op = opId();
    expect(run(op, { task: SWEEPS[0], toolCalls: 0 })).toMatchObject({ kind: "nudge" });
    expect(run(op, { task: SWEEPS[0], toolCalls: 0 })).toEqual({ kind: "continue" });
  });
});
