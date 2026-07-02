import { describe, it, expect, beforeEach } from "vitest";
import {
  recordDesignVerdict,
  runDesignVerifyGate,
  getDesignVerifyRetries,
  clearDesignVerifyStateForOp,
  formatDesignNudgeForAgent,
  _resetDesignVerifyState,
} from "./design-verify.js";
import { runRenderVerifyGate, _resetRenderVerifyState } from "./render-verify.js";
import type { Op } from "../../ops/types.js";

const op = (id: string) => ({ id }) as unknown as Op;

beforeEach(() => {
  _resetDesignVerifyState();
  _resetRenderVerifyState();
});

describe("runDesignVerifyGate — threshold", () => {
  it("a weak score (≤2) recorded by the probe triggers ONE capped retry", () => {
    recordDesignVerdict("op-weak", { score: 2, issues: ["emoji used as icons", "low text contrast"] });
    const gate = runDesignVerifyGate(op("op-weak"));
    expect(gate.shouldRetry).toBe(true);
    expect(gate.capReached).toBe(false);
    expect(getDesignVerifyRetries("op-weak")).toBe(1);
    expect(gate.nudge).toContain("2/5");
    expect(gate.nudge).toContain("emoji used as icons");
  });

  it("a passable score (>2) does not retry", () => {
    recordDesignVerdict("op-ok", { score: 3, issues: ["cramped spacing"] });
    const gate = runDesignVerifyGate(op("op-ok"));
    expect(gate.shouldRetry).toBe(false);
    expect(gate.capReached).toBe(false);
    expect(getDesignVerifyRetries("op-ok")).toBe(0);
  });

  it("score 0 (crude/unstyled) retries", () => {
    recordDesignVerdict("op-crude", { score: 0, issues: [] });
    expect(runDesignVerifyGate(op("op-crude")).shouldRetry).toBe(true);
  });
});

describe("runDesignVerifyGate — no verdict never fires (score-absent ⇒ no rebuild)", () => {
  it("no recorded verdict → no retry", () => {
    const gate = runDesignVerifyGate(op("op-none"));
    expect(gate.shouldRetry).toBe(false);
    expect(gate.nudge).toBe("");
  });

  it("drains once — a verdict recorded this turn is not re-nagged next turn", () => {
    recordDesignVerdict("op-drain", { score: 1, issues: ["unstyled"] });
    expect(runDesignVerifyGate(op("op-drain")).shouldRetry).toBe(true);
    // Second call with no fresh record: the stash was drained, so nothing fires.
    const again = runDesignVerifyGate(op("op-drain"));
    expect(again.shouldRetry).toBe(false);
    expect(again.nudge).toBe("");
  });
});

describe("runDesignVerifyGate — cap", () => {
  it("stops after MAX_RETRIES (1): the second weak verdict reports capReached, not a retry", () => {
    recordDesignVerdict("op-cap", { score: 1, issues: ["no hierarchy"] });
    const first = runDesignVerifyGate(op("op-cap"));
    expect(first.shouldRetry).toBe(true);

    recordDesignVerdict("op-cap", { score: 1, issues: ["still no hierarchy"] });
    const second = runDesignVerifyGate(op("op-cap"));
    expect(second.shouldRetry).toBe(false);
    expect(second.capReached).toBe(true);
    // The label is NOT demoted — capReached carries no ledger verdict; it only
    // signals the loop to stop. (No recordOrchestratorVerify call exists here.)
    expect(getDesignVerifyRetries("op-cap")).toBe(1);
  });
});

describe("clearDesignVerifyStateForOp", () => {
  it("wipes the stash and retry counter so a later op reuse starts fresh", () => {
    recordDesignVerdict("op-clr", { score: 1, issues: ["x"] });
    runDesignVerifyGate(op("op-clr"));
    expect(getDesignVerifyRetries("op-clr")).toBe(1);
    clearDesignVerifyStateForOp("op-clr");
    expect(getDesignVerifyRetries("op-clr")).toBe(0);
    // Stash cleared too — no stale verdict fires.
    expect(runDesignVerifyGate(op("op-clr")).shouldRetry).toBe(false);
  });
});

// Cross-seam contract: the render probe receives the opId and keys the design
// stash off it, so a clean (non-broken) render still surfaces a low design score
// to this gate — the wiring that was previously parked.
describe("render-probe → design-verify seam", () => {
  it("a probe that records a design verdict off its opId drives the design gate", async () => {
    const render = await runRenderVerifyGate("op-seam", {
      totalMs: 0,
      appUrl: "http://127.0.0.1:7007/apps/x/index.html",
      appDescription: "a todo app",
      // Non-broken render (no errors) — but the same probe scored the design low
      // and stashed it against the opId it was handed.
      probe: async (_url, _desc, opId) => {
        recordDesignVerdict(opId, { score: 1, issues: ["unstyled generic look"] });
        return [];
      },
    });
    // Render gate passes (nothing broken)…
    expect(render.shouldRetry).toBe(false);
    // …but the design gate now fires on the score the probe surfaced.
    const design = runDesignVerifyGate(op("op-seam"));
    expect(design.shouldRetry).toBe(true);
    expect(design.nudge).toContain("unstyled generic look");
  });
});

describe("formatDesignNudgeForAgent", () => {
  it("frames it as polish (not a runtime error) and lists the concrete issues", () => {
    const nudge = formatDesignNudgeForAgent({ score: 2, issues: ["low text contrast", "generic template look"] });
    expect(nudge).toContain("NOT a runtime error");
    expect(nudge).toContain("- low text contrast");
    expect(nudge).toContain("- generic template look");
  });

  it("degrades to a default line when the judge listed no specific issues", () => {
    const nudge = formatDesignNudgeForAgent({ score: 1, issues: [] });
    expect(nudge).toContain("no clear visual hierarchy");
  });
});
