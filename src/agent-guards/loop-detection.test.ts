/**
 * Loop-detection guard tests — the nudge-only policy and the legit-repeat
 * safety that keep an interactive chat from either spinning forever (the grok
 * `ls workspace/apps/` loop) or hard-killing a turn the user actually wanted.
 */

import { describe, it, expect } from "vitest";
import { checkToolLoops, noteToolResults, createLoopState, NO_PROGRESS_LIMIT, SPIRALABLE_TOOLS, type LoopState } from "./loop-detection.js";
import { TOOLS } from "../tool-registry.js";

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

describe("checkToolLoops — no-progress (result-delta, not tool-identity)", () => {
  // Varied args so exact-repeat can't fire (key changes every turn) and bash
  // isn't a discovery tool — so ONLY the no-progress path is under test. The
  // RESULT is what decides progress now, not the tool's class.
  const ROOM = NO_PROGRESS_LIMIT + 5; // absorb the detector's one-turn lag
  const bashTurn = (state: LoopState, i: number, result: string, opts: Parameters<typeof checkToolLoops>[2]) =>
    turn(state, [{ name: "bash", arguments: JSON.stringify({ cmd: "diag " + i }) }], result, opts);

  it("bash-spin with UNCHANGING results hard-aborts (the git-status loop)", () => {
    const state = createLoopState();
    let aborted = false;
    for (let i = 0; i < ROOM && !aborted; i++) {
      aborted = bashTurn(state, i, "nothing to commit, working tree clean", { modelTier: "strong" }).abort;
    }
    expect(aborted).toBe(true);
  });

  it("interactive (nudgeOnly): the same spin is nudged, never aborted", () => {
    const state = createLoopState();
    let nudged = false, aborted = false;
    for (let i = 0; i < ROOM; i++) {
      const v = bashTurn(state, i, "no change", { modelTier: "strong", nudgeOnly: true });
      if (v.nudge) nudged = true;
      if (v.abort) aborted = true;
    }
    expect(aborted).toBe(false);
    expect(nudged).toBe(true);
  });

  it("research liveness: bash/fetch returning NEW results each turn never aborts", () => {
    const state = createLoopState();
    let flagged = false;
    for (let i = 0; i < ROOM * 2; i++) {
      const v = turn(state, [{ name: "web_fetch", arguments: JSON.stringify({ url: "p/" + i }) }], "page-content-" + i, { modelTier: "strong" });
      if (v.abort || v.nudge) flagged = true;
    }
    expect(flagged).toBe(false);
  });

  it("same-result spin across VARIED tools aborts (no tool repeats its key)", () => {
    const state = createLoopState();
    let aborted = false;
    for (let i = 0; i < ROOM && !aborted; i++) {
      // Alternate two different non-mutating, non-discovery tools; identical
      // result every turn → no new information enters → no progress.
      const call = i % 2 === 0
        ? { name: "bash", arguments: JSON.stringify({ cmd: "probe " + i }) }
        : { name: "web_fetch", arguments: JSON.stringify({ url: "u/" + i }) };
      aborted = turn(state, [call], "same-unchanged-state", { modelTier: "strong" }).abort;
    }
    expect(aborted).toBe(true);
  });

  it("no degradation: a constant-ack mutation (email_send) is never false-aborted", () => {
    const state = createLoopState();
    let flagged = false;
    for (let i = 0; i < ROOM * 2; i++) {
      // Real fire-and-forget side effects whose ack is a constant string —
      // the mutation floor must keep these from reading as a spin.
      const v = turn(state, [{ name: "email_send", arguments: JSON.stringify({ to: "user-" + i }) }], "[ok] sent", { modelTier: "strong" });
      if (v.abort || v.nudge) flagged = true;
    }
    expect(flagged).toBe(false);
  });
});

describe("checkToolLoops — discovery (result-delta)", () => {
  const ROOM = 16;
  const searchTurn = (state: LoopState, i: number, result: string) =>
    turn(state, [{ name: "web_search", arguments: JSON.stringify({ q: "query " + i }) }], result, { modelTier: "strong" });

  it("a discovery tool returning the SAME results spirals into a nudge", () => {
    const state = createLoopState();
    let nudged = false;
    for (let i = 0; i < ROOM; i++) {
      if (searchTurn(state, i, "no results found").nudge) nudged = true;
    }
    expect(nudged).toBe(true);
  });

  it("a discovery tool returning NEW results each call is never nudged", () => {
    const state = createLoopState();
    let nudged = false;
    for (let i = 0; i < ROOM; i++) {
      if (searchTurn(state, i, "fresh hits " + i).nudge) nudged = true;
    }
    expect(nudged).toBe(false);
  });
});

describe("SPIRALABLE_TOOLS fence — every discovery tool is read-only", () => {
  // The discovery set is the one curated list left (no risk tier models
  // "discovery spin"). Fence it with the taxonomy so a mutating tool can never
  // be mistaken for a harmless lookup — that would let a real loop reset the
  // wrong counter.
  it("no spiralable tool is mutating (risk ∈ {safe, network-read})", () => {
    for (const name of SPIRALABLE_TOOLS) {
      const risk = TOOLS[name]?.risk;
      expect(risk, `${name} must be in the policy table`).toBeDefined();
      expect(["safe", "network-read"], `${name} is risk=${risk}, not read-only`).toContain(risk);
    }
  });

  it("the fence is not vacuous — a write-class tool would fail it", () => {
    expect(["safe", "network-read"]).not.toContain(TOOLS["write"]?.risk);
  });
});
