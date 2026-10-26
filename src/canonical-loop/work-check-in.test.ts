/**
 * A worker is found stuck by its tree, not by a clock: every CHECK_IN_TURNS
 * turns the work root is fingerprinted, and STUCK_AFTER check-ins in a row
 * with nothing changed on disk stop the op. A change resets the count; a
 * root the fingerprint cannot read, an op with no root, and the interactive
 * lane are never judged here. The fingerprint is a seam (the loop spawns
 * nothing); agency/work-tree-fingerprint.test.ts proves the git one.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Op } from "../ops/types.js";
import { CHECK_IN_TURNS, STUCK_AFTER, evaluateWorkCheckIn, registerWorkTreeFingerprint } from "./work-check-in.js";
import { clearMiddlewareStateForOp } from "./middlewares/state.js";

const repo = "C:/w/project";
const plain = "C:/w/not-a-repo";

let seq = 0;
function op(lane: Op["lane"], workRoot?: string): Op {
  const id = `op-check-in-${++seq}`;
  return { id, lane, contextPack: { routing: { lane, ...(workRoot ? { workRoot } : {}) } } } as unknown as Op;
}

beforeEach(() => { seq += 100; });

describe("evaluateWorkCheckIn", () => {
  it("stops a worker whose tree has not changed across STUCK_AFTER check-ins, with its committed turns intact", () => {
    const o = op("agent", repo);
    const fingerprint = () => "same";
    let decision = evaluateWorkCheckIn(o, 0, fingerprint);
    for (let turn = 1; turn <= CHECK_IN_TURNS * (STUCK_AFTER + 1); turn++) {
      decision = evaluateWorkCheckIn(o, turn, fingerprint);
      if (decision.stop) {
        expect(turn).toBe(CHECK_IN_TURNS * (STUCK_AFTER + 1));
        break;
      }
    }
    expect(decision).toMatchObject({ stop: true, reason: "no-change-on-disk" });
    expect(decision.detail).toContain(repo);
    clearMiddlewareStateForOp(o.id);
  });

  it("a change on disk between check-ins resets the count", () => {
    const o = op("build", repo);
    let value = "v1";
    const fingerprint = () => value;
    for (let turn = 1; turn <= CHECK_IN_TURNS * STUCK_AFTER; turn++) {
      if (turn === CHECK_IN_TURNS * STUCK_AFTER - 1) value = "v2";
      expect(evaluateWorkCheckIn(o, turn, fingerprint).stop).toBe(false);
    }
    clearMiddlewareStateForOp(o.id);
  });

  it("judges only at check-in turns, and never an op without a root, an interactive op, or a non-git root", () => {
    const stuck = () => "same";
    const withRoot = op("agent", repo);
    expect(evaluateWorkCheckIn(withRoot, CHECK_IN_TURNS + 1, stuck).stop).toBe(false);
    expect(evaluateWorkCheckIn(op("agent"), CHECK_IN_TURNS * 10, stuck).stop).toBe(false);
    expect(evaluateWorkCheckIn(op("interactive", repo), CHECK_IN_TURNS * 10, stuck).stop).toBe(false);
    const offGit = op("agent", plain);
    const unreadable = (root: string) => (root === plain ? null : "same");
    for (let n = 1; n <= STUCK_AFTER + 2; n++) expect(evaluateWorkCheckIn(offGit, CHECK_IN_TURNS * n, unreadable).stop).toBe(false);
    clearMiddlewareStateForOp(withRoot.id);
  });

  it("reads unknown until the server registers a fingerprint, then uses it", () => {
    const o = op("agent", repo);
    registerWorkTreeFingerprint(null);
    expect(evaluateWorkCheckIn(o, CHECK_IN_TURNS).stop).toBe(false);
    registerWorkTreeFingerprint(() => "same");
    try {
      let decision = evaluateWorkCheckIn(o, CHECK_IN_TURNS);
      for (let n = 2; n <= STUCK_AFTER + 1; n++) decision = evaluateWorkCheckIn(o, CHECK_IN_TURNS * n);
      expect(decision.stop).toBe(true);
    } finally {
      registerWorkTreeFingerprint(null);
      clearMiddlewareStateForOp(o.id);
    }
  });
});
