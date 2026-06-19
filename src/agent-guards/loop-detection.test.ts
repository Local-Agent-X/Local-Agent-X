/**
 * Loop-detection guard tests — the nudge-only policy and the legit-repeat
 * safety that keep an interactive chat from either spinning forever (the grok
 * `ls workspace/apps/` loop) or hard-killing a turn the user actually wanted.
 */

import { describe, it, expect } from "vitest";
import { checkToolLoops, noteToolResults, createLoopState, NO_PROGRESS_LIMIT, type LoopState } from "./loop-detection.js";

type Call = { name: string; arguments: string };
const lsCall: Call = { name: "bash", arguments: JSON.stringify({ cmd: "ls workspace/apps/" }) };

// One agent turn: the guard runs before dispatch (afterModelCall), results are
// recorded after (afterToolExecution). Returns the guard verdict for that turn.
function turn(state: LoopState, calls: Call[], result: string, opts: Parameters<typeof checkToolLoops>[2]) {
  const verdict = checkToolLoops(calls, state, opts);
  noteToolResults(calls, state, calls.map(() => ({ content: result })));
  return verdict;
}

describe("checkToolLoops — exact-repeat", () => {
  it("interactive (nudgeOnly): a same-call/same-result spin is nudged, never aborted", () => {
    const state = createLoopState();
    let nudged = false, aborted = false;
    for (let i = 0; i < 6; i++) {
      const v = turn(state, [lsCall], "identical-output", { modelTier: "strong", nudgeOnly: true });
      if (v.nudge) nudged = true;
      if (v.abort) aborted = true;
    }
    expect(aborted).toBe(false);
    expect(nudged).toBe(true);
  });

  it("worker (default): the same spin hard-aborts", () => {
    const state = createLoopState();
    let aborted = false;
    for (let i = 0; i < 6 && !aborted; i++) {
      aborted = turn(state, [lsCall], "identical-output", { modelTier: "strong" }).abort;
    }
    expect(aborted).toBe(true);
  });

  it("a repeated call whose result CHANGES each time is never flagged (legit repeat)", () => {
    const state = createLoopState();
    let flagged = false;
    for (let i = 0; i < 8; i++) {
      const v = turn(state, [lsCall], "output-" + i, { modelTier: "strong" });
      if (v.abort || v.nudge) flagged = true;
    }
    expect(flagged).toBe(false);
  });
});

describe("checkToolLoops — no-progress", () => {
  // Changing args + changing results so ONLY the no-progress path can fire
  // (exact-repeat resets on the key change; bash isn't a discovery tool).
  const noProgressTurn = (state: LoopState, i: number, opts: Parameters<typeof checkToolLoops>[2]) =>
    turn(state, [{ name: "bash", arguments: JSON.stringify({ cmd: "echo " + i }) }], "out-" + i, opts);

  it("interactive (nudgeOnly): a no-progress spiral is nudged, never aborted", () => {
    const state = createLoopState();
    let nudged = false, aborted = false;
    for (let i = 0; i <= NO_PROGRESS_LIMIT; i++) {
      const v = noProgressTurn(state, i, { modelTier: "strong", nudgeOnly: true });
      if (v.nudge) nudged = true;
      if (v.abort) aborted = true;
    }
    expect(aborted).toBe(false);
    expect(nudged).toBe(true);
  });

  it("worker (default): a no-progress spiral hard-aborts", () => {
    const state = createLoopState();
    let aborted = false;
    for (let i = 0; i <= NO_PROGRESS_LIMIT && !aborted; i++) {
      aborted = noProgressTurn(state, i, { modelTier: "strong" }).abort;
    }
    expect(aborted).toBe(true);
  });
});
