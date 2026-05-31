/**
 * Tests for the generic (in-loop) surgeon registry (generic-surgeon.ts).
 *
 * The registry decouples self-edit/* from the canonical loop: the runner is
 * registered at server startup; runGenericSurgeon never throws — a missing
 * registration or a runner error is reported in the result.
 */

import { describe, it, expect } from "vitest";
import { isGenericSurgeonRegistered, registerGenericSurgeon, runGenericSurgeon } from "../src/self-edit/generic-surgeon.js";

describe("generic surgeon registry", () => {
  it("is unregistered before any runner is wired", () => {
    expect(isGenericSurgeonRegistered()).toBe(false);
  });

  it("reports unavailable (not throw) when no runner is registered", async () => {
    const r = await runGenericSurgeon("/tmp/wt", "do the thing");
    expect(r.ok).toBe(false);
    expect(r.output).toContain("unavailable");
  });

  it("dispatches to the registered runner and returns its output", async () => {
    registerGenericSurgeon(async (wt, msg) => `ran in ${wt}: ${msg}`);
    expect(isGenericSurgeonRegistered()).toBe(true);
    const r = await runGenericSurgeon("/tmp/wt", "fix bug");
    expect(r.ok).toBe(true);
    expect(r.output).toBe("ran in /tmp/wt: fix bug");
  });

  it("reports a runner error (not throw)", async () => {
    registerGenericSurgeon(async () => { throw new Error("loop blew up"); });
    const r = await runGenericSurgeon("/tmp/wt", "fix bug");
    expect(r.ok).toBe(false);
    expect(r.output).toContain("loop blew up");
  });
});
