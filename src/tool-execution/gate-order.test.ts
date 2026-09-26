// The gate ORDER in securityAndValidationGates is load-bearing security, and
// until now only source order expressed it. This pins the one edge the order
// exists to settle.
//
// A name that is not a tool used to reach the ARI kernel first. An unmapped
// name is indistinguishable there from a real tool someone forgot to classify,
// so the kernel fail-closed with "not in TOOL_CLASS_MAP — classify it in
// src/ari-kernel/tool-class-map.ts". The model that had hallucinated
// `switch_tab` (an ACTION of `browser`) read that as a broken engine and
// disowned correct work; the engineer reading the session afterwards followed
// the same message toward adding a kernel class for a tool that does not exist.
// lookupTool's corrective — the exact names this op can call — was unreachable.
import { describe, expect, it } from "vitest";

import { enforcePolicyPhase } from "./enforce-policy.js";
import { makeCtx } from "./capability-class-gates.test-helper.js";
import type { ToolDefinition } from "../types.js";

const browser: ToolDefinition = {
  name: "browser",
  description: "",
  parameters: { properties: { action: { enum: ["navigate", "tabs", "switch_tab"] } } },
  execute: async () => ({ content: "" }),
} as unknown as ToolDefinition;

/** An op whose surface is exactly `browser` — the shape of the live session. */
function ctxFor(calledName: string) {
  const ctx = makeCtx(calledName, {}, "gate-order-test");
  (ctx as { toolMap: Map<string, ToolDefinition> }).toolMap = new Map([["browser", browser]]);
  return ctx;
}

describe("a name that is not a tool is settled before any gate judges it", () => {
  it("answers a hallucinated action with the call shape, never with a kernel classification error", async () => {
    const ctx = ctxFor("switch_tab");
    await enforcePolicyPhase(ctx);

    const content = ctx.result?.content ?? "";
    expect(ctx.allowed).toBe(false);
    expect(content).toContain('call browser with action="switch_tab"');
    // The regression: the kernel's fail-closed text sends a reader to classify
    // a tool that does not exist.
    expect(content).not.toContain("TOOL_CLASS_MAP");
    expect(content).not.toContain("tool-class-map.ts");
  });

  it("still refuses a name no tool declares — the reorder loosens nothing", async () => {
    const ctx = ctxFor("totally_made_up");
    await enforcePolicyPhase(ctx);

    expect(ctx.allowed).toBe(false);
    expect(ctx.result?.content ?? "").toContain('Unknown tool "totally_made_up"');
  });
});
