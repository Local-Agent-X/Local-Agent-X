// One judgement per outbound request; the channel decides how the session's
// taint is read. The tool channel reads the floor (an unprovable payload from
// a tainted session is refused); the browser reads positive overlap only (a
// page's own traffic must keep rendering after one sensitive read).
import { describe, it, expect } from "vitest";
import { EGRESS_CHANNEL_TAINT, judgeEgress, type DispatchEgressState } from "./egress-judge.js";

const HIT = { source: "sensitive_file" as const, target: "~/.ssh/id_rsa" };

function state(over: Partial<DispatchEgressState> = {}): DispatchEgressState & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    checkCanariesInPayload: (s, p) => { calls.push("canary"); return p.includes("CANARY-1") ? "CANARY-1" : null; },
    findTaintInPayload: (s, p) => { calls.push("overlap"); return p.includes("secret-bytes") ? [HIT] : []; },
    checkEgressTaintWithPayload: (s, p) => {
      calls.push("floor");
      return p.includes("secret-bytes")
        ? { blocked: true, reason: "overlap reason", evidence: [HIT] }
        : p.includes("unprovable") ? { blocked: true, reason: "floor reason", evidence: [] } : { blocked: false, evidence: [] };
    },
    ...over,
  };
}

describe("judgeEgress", () => {
  it("each channel's taint reading is declared in one table", () => {
    expect(EGRESS_CHANNEL_TAINT).toEqual({ "tool-dispatch": "floor", "browser-page": "overlap", "tool-send": "overlap" });
  });

  it("a clean payload carries no evidence on either channel", () => {
    expect(judgeEgress(state(), "tool-dispatch", "s", "hello")).toEqual({ canary: false, taint: null });
    expect(judgeEgress(state(), "browser-page", "s", "hello")).toEqual({ canary: false, taint: null });
  });

  it("a canary is evidence on every channel", () => {
    expect(judgeEgress(state(), "tool-dispatch", "s", "x CANARY-1 y").canary).toBe(true);
    expect(judgeEgress(state(), "browser-page", "s", "x CANARY-1 y").canary).toBe(true);
  });

  it("the tool channel reads the floor: an unprovable payload is refused with the floor's reason", () => {
    const st = state();
    expect(judgeEgress(st, "tool-dispatch", "s", "unprovable")).toEqual({ canary: false, taint: { reason: "floor reason", sources: [] } });
    expect(st.calls).toEqual(["canary", "floor"]);
  });

  it("the browser channel reads overlap only: the same unprovable payload passes, real overlap is refused", () => {
    const st = state();
    expect(judgeEgress(st, "browser-page", "s", "unprovable").taint).toBeNull();
    expect(judgeEgress(st, "browser-page", "s", "carries secret-bytes").taint).toEqual({ sources: [HIT] });
    expect(st.calls).not.toContain("floor");
  });

  it("the browser channel runs against state that has no floor at all (the egress worker's mirrors)", () => {
    const { checkCanariesInPayload, findTaintInPayload } = state();
    expect(judgeEgress({ checkCanariesInPayload, findTaintInPayload }, "browser-page", "s", "carries secret-bytes").taint).not.toBeNull();
  });
});
