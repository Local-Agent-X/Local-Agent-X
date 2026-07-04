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
import { shouldPinIntentToolChoice } from "../src/agent-request/prepare-request.js";

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
