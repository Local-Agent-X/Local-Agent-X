/**
 * ARI fail-closed contract.
 *
 * Regression guard: when the kernel is required but its firewall never
 * started, a gated tool call must be BLOCKED — not silently allowed. The
 * tool gate (enforce-policy.ts:ariKernelGate) routes every gated tool
 * through ariEvaluate unconditionally, so this branch is what stands between
 * "ARI failed to start" and "agent does ungated I/O." Previously the gate
 * guarded on isAriActive(), making this branch unreachable.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ariEvaluate, stopAriKernel } from "../src/ari-kernel/index.js";
import { setAriRequired } from "../src/ari-kernel/state.js";

afterEach(() => {
  stopAriKernel();
  setAriRequired(true);
});

describe("ARI fail-closed when the kernel is inactive", () => {
  it("blocks a gated tool when required and the firewall never started", async () => {
    stopAriKernel(); // firewall === null
    setAriRequired(true);

    const r = await ariEvaluate("bash", "exec", { command: "id" });

    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/not active/i);
  });

  it("falls through only when ARI is explicitly not required", async () => {
    stopAriKernel();
    setAriRequired(false);

    const r = await ariEvaluate("bash", "exec", { command: "id" });

    expect(r.allowed).toBe(true);
  });
});
