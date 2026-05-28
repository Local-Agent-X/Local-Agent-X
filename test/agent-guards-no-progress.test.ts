import { describe, it, expect } from "vitest";

import { checkToolLoops, createLoopState, NO_PROGRESS_LIMIT_WEAK } from "../src/agent-guards/index.js";

// The no-progress guard used to fire on browser-driven tasks because
// MUTATION_TOOLS was file-only. Live failure 2026-05-13 (Thriveventory PO
// entry on codex): "No-progress abort: 6+ iterations of tool calls with
// zero file mutations." The agent was actually doing the task (filling
// the PO form via `browser`), but the guard's narrow definition of
// "progress" saw nothing. Tests pin the new contract — every side-
// effecting tool resets the counter.
//
// The threshold is 12 for strong models, 6 for weak/medium. We test
// at the lower threshold since that's where the false positive showed
// up first.

// Vary args per call so the exact-repeat detector (separate path that fires
// on 2-3x identical tool+args) doesn't trip first and mask the no-progress
// check we're trying to test. Real-world browser/HTTP sequences always have
// different args per call (different selectors, urls, fields).
function callOf(name: string, i = 0) {
  return { name, arguments: JSON.stringify({ step: i }) };
}

describe("no-progress abort — browser calls count as mutation", () => {
  it("6 consecutive browser calls do NOT trigger the no-progress abort (weak model)", () => {
    const state = createLoopState();
    let lastResult: ReturnType<typeof checkToolLoops> | null = null;
    for (let i = 0; i < 8; i++) {
      lastResult = checkToolLoops([callOf("browser", i)], state, { modelTier: "weak" });
    }
    expect(lastResult!.abort).toBe(false);
  });

  it("6 consecutive http_request calls do NOT trigger the no-progress abort (weak model)", () => {
    const state = createLoopState();
    let lastResult: ReturnType<typeof checkToolLoops> | null = null;
    for (let i = 0; i < 8; i++) {
      lastResult = checkToolLoops([callOf("http_request", i)], state, { modelTier: "weak" });
    }
    expect(lastResult!.abort).toBe(false);
  });

  it("6 consecutive email_send calls do NOT trigger the no-progress abort", () => {
    const state = createLoopState();
    let lastResult: ReturnType<typeof checkToolLoops> | null = null;
    for (let i = 0; i < 8; i++) {
      lastResult = checkToolLoops([callOf("email_send", i)], state, { modelTier: "weak" });
    }
    expect(lastResult!.abort).toBe(false);
  });
});

describe("no-progress abort — fires on genuine read-only loops", () => {
  // Note: `read` and `glob` are SPIRALABLE_TOOLS and have their own
  // discovery-loop detection that fires at a lower threshold. To exercise
  // the no-progress guard specifically, we use a tool that's neither a
  // mutation NOR spiralable — `web_fetch` qualifies (read-only, but not
  // in the SPIRALABLE_TOOLS set that would trip discovery-loop first).
  // Threshold is imported from agent-guards.ts so this test stays in sync
  // when the production limit is retuned.

  it("triggers past the weak threshold of non-mutation calls", () => {
    const state = createLoopState();
    let aborted = false;
    for (let i = 0; i < NO_PROGRESS_LIMIT_WEAK + 2; i++) {
      const r = checkToolLoops([callOf("web_fetch", i)], state, { modelTier: "weak" });
      if (r.abort) { aborted = true; break; }
    }
    expect(aborted).toBe(true);
  });

  it("counter resets when a mutation fires mid-stream", () => {
    const state = createLoopState();
    // 4 non-mutation calls
    for (let i = 0; i < 4; i++) {
      checkToolLoops([callOf("web_fetch", i)], state, { modelTier: "weak" });
    }
    // One mutation — should reset counter
    checkToolLoops([callOf("write", 0)], state, { modelTier: "weak" });
    // 4 more non-mutation calls — under threshold, should not abort
    let aborted = false;
    for (let i = 0; i < 4; i++) {
      const r = checkToolLoops([callOf("web_fetch", i)], state, { modelTier: "weak" });
      if (r.abort) { aborted = true; break; }
    }
    expect(aborted).toBe(false);
  });
});

describe("no-progress abort — mixed sequences typical of real tasks", () => {
  it("PO-entry-shaped sequence (browser × 8, no files) does NOT abort", () => {
    // Reproduces the Thriveventory failure shape: agent makes many browser
    // calls without writing any files. Pre-fix this aborted at iteration 6.
    const state = createLoopState();
    let aborted = false;
    for (let i = 0; i < 12; i++) {
      const r = checkToolLoops([callOf("browser", i)], state, { modelTier: "weak" });
      if (r.abort) { aborted = true; break; }
    }
    expect(aborted).toBe(false);
  });

  it("research-shaped sequence (web_fetch interleaved with browser) does NOT abort", () => {
    const state = createLoopState();
    let aborted = false;
    for (let i = 0; i < 12; i++) {
      const r = checkToolLoops(
        [callOf(i % 2 === 0 ? "web_fetch" : "browser", i)],
        state,
        { modelTier: "weak" },
      );
      if (r.abort) { aborted = true; break; }
    }
    expect(aborted).toBe(false);
  });
});
