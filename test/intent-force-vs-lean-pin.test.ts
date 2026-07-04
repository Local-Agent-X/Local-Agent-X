/**
 * Regression for the build_app trigger-happiness fix (Chunk 2): saying "build"
 * hard-forced build_app and shipped a generic page with zero discovery, because
 * the tool_choice pin fired on ANY non-free verdict. The fix grades the verdict —
 * only mode="force" pins; mode="lean" narrows-but-does-not-pin so the model can
 * ask clarifying questions first.
 *
 * shouldPinIntentToolChoice is the single chokepoint that decision now flows
 * through. These pin the force/lean/self_edit rules so a regression to
 * "pin on any non-free kind" fails here.
 */
import { describe, it, expect } from "vitest";
import { shouldPinIntentToolChoice, recordIntentOutcome } from "../src/agent-request/prepare-request.js";

describe("shouldPinIntentToolChoice — pin only on force", () => {
  it("pins a fully-specified (force) build_app ask", () => {
    expect(shouldPinIntentToolChoice({ kind: "build_app", mode: "force" })).toBe(true);
  });

  it("does NOT pin a thin (lean) build_app ask — the trigger-happiness fix", () => {
    // "build me a page for my gym" → lean. Before the fix this pinned and shipped
    // a generic page; now it must narrow without pinning so the model can ask.
    expect(shouldPinIntentToolChoice({ kind: "build_app", mode: "lean" })).toBe(false);
  });

  it("pins a force agent_spawn ask", () => {
    expect(shouldPinIntentToolChoice({ kind: "agent_spawn", mode: "force" })).toBe(true);
  });

  it("does NOT pin a lean agent_spawn ask", () => {
    expect(shouldPinIntentToolChoice({ kind: "agent_spawn", mode: "lean" })).toBe(false);
  });

  it("never pins self_edit, even at mode=force (destructive; needs same-turn permission)", () => {
    expect(shouldPinIntentToolChoice({ kind: "self_edit", mode: "force" })).toBe(false);
  });

  it("never pins free", () => {
    expect(shouldPinIntentToolChoice({ kind: "free", mode: "lean" })).toBe(false);
    expect(shouldPinIntentToolChoice({ kind: "free", mode: "force" })).toBe(false);
  });

  it("does not pin a null/absent verdict", () => {
    expect(shouldPinIntentToolChoice(null)).toBe(false);
    expect(shouldPinIntentToolChoice(undefined)).toBe(false);
  });
});

describe("recordIntentOutcome — Chunk 4 force/lean tally", () => {
  // Process-lifetime counter; assert DELTAS off a baseline, not absolutes, so
  // test ordering doesn't matter.
  it("counts a pinned turn as forced and reports the running ratio", () => {
    const before = recordIntentOutcome(false); // seed one lean
    const after = recordIntentOutcome(true);    // then one force
    expect(after.forced).toBe(before.forced + 1);
    expect(after.leaned).toBe(before.leaned);
    // pinnedPct = forced / (forced+leaned) * 100, rounded.
    const total = after.forced + after.leaned;
    expect(after.pinnedPct).toBe(Math.round((after.forced / total) * 100));
  });

  it("counts a lean turn without incrementing forced", () => {
    const before = recordIntentOutcome(true);
    const after = recordIntentOutcome(false);
    expect(after.leaned).toBe(before.leaned + 1);
    expect(after.forced).toBe(before.forced);
  });
});
