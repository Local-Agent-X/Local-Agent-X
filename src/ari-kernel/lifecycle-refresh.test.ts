// Regression: restricted mode must NOT survive an op boundary.
//
// The bug: the ARI Firewall is a process singleton, and the runtime's
// restricted mode (entered after N denied sensitive actions) lives on a
// per-Firewall run-state with no in-place reset. LAX built one firewall for
// the whole process, so a single tripped guard in one op locked EVERY later
// op into read-only until server restart. refreshAriKernelRunIfStuck() — run
// at each op boundary in canonical-loop/worker.ts — rebuilds the firewall so a
// prior op's escalation can't brick the next one.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startAriKernel,
  stopAriKernel,
  refreshAriKernelRun,
  releaseAriKernelScope,
} from "./lifecycle.js";
import { getFirewallForTest } from "./state.js";
import { ariEvaluate } from "./evaluate.js";

/** The live firewall, narrowed to the run-state getters we assert on. */
function fw(): { isRestricted?: boolean; restrictedAt?: unknown } | null {
  return getFirewallForTest() as unknown as { isRestricted?: boolean; restrictedAt?: unknown } | null;
}

/** Drive denied sensitive actions (tainted shell execs — the exact class that
 *  bricked the live run) until the firewall enters restricted mode. The taint
 *  source must be a valid kernel enum ("web"); a tainted shell exec is refused
 *  by deny-tainted-shell and flips restricted mode. Loop with a safe margin so
 *  the test doesn't couple to whether entry is immediate or counter-based. */
async function tripRestricted(): Promise<void> {
  for (let i = 0; i < 15 && fw()?.isRestricted !== true; i++) {
    await ariEvaluate("bash", "exec", { command: `echo ${i}` }, ["web"]);
  }
}

async function tripRestrictedScope(scopeId: string): Promise<void> {
  const scoped = () => getFirewallForTest(scopeId) as unknown as { isRestricted?: boolean } | null;
  for (let i = 0; i < 15 && scoped()?.isRestricted !== true; i++) {
    await ariEvaluate("bash", "exec", { command: `echo ${i}` }, ["web"], scopeId);
  }
}

describe("ARI run refresh — restricted mode does not survive an op boundary", () => {
  let dir: string;
  const prevKey = process.env.LAX_AUDIT_KEY;

  beforeEach(async () => {
    // Fixed key so the test never reads/creates the real ~/.lax/audit-key.
    process.env.LAX_AUDIT_KEY = "test-ari-refresh-key-0123456789abcdef";
    dir = mkdtempSync(join(tmpdir(), "lax-ari-refresh-"));
    await startAriKernel(join(dir, "ari-audit.db"), "workspace-assistant", true);
  });

  afterEach(() => {
    stopAriKernel();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (prevKey === undefined) delete process.env.LAX_AUDIT_KEY;
    else process.env.LAX_AUDIT_KEY = prevKey;
  });

  it("a tripped run blocks a file write by restricted mode, and a refresh clears it", async () => {
    await tripRestricted();
    expect(fw()?.isRestricted).toBe(true);
    const blocked = await ariEvaluate("write", "write", { path: join(dir, "x.txt"), content: "y" });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toMatch(/restricted mode/i);
    expect(refreshAriKernelRun()).toBe(true);
    expect(fw()?.isRestricted).toBe(false);
    const after = await ariEvaluate("write", "write", { path: join(dir, "x.txt"), content: "y" });
    expect(after.reason ?? "").not.toMatch(/restricted mode/i);
  });

  it("refreshAriKernelRun replaces the firewall with a fresh run-state", async () => {
    await tripRestricted();
    expect(fw()?.isRestricted).toBe(true);
    const before = getFirewallForTest();

    expect(refreshAriKernelRun()).toBe(true);

    expect(getFirewallForTest()).not.toBe(before);
    expect(fw()?.isRestricted).toBe(false);
  });

  it("keeps quarantine and sticky run-state isolated by operation", async () => {
    const opA = "op-isolation-a";
    const opB = "op-isolation-b";
    await ariEvaluate("memory_search", "search", { query: "clean" }, [], opB);
    const beforeB = getFirewallForTest(opB);

    await tripRestrictedScope(opA);
    expect((getFirewallForTest(opA) as unknown as { isRestricted?: boolean })?.isRestricted).toBe(true);
    expect((getFirewallForTest(opB) as unknown as { isRestricted?: boolean })?.isRestricted).not.toBe(true);

    const bShell = await ariEvaluate("bash", "exec", { command: "git status" }, [], opB);
    expect(bShell.allowed).toBe(true);
    expect(getFirewallForTest(opB)).toBe(beforeB);

    expect(releaseAriKernelScope(opA)).toBe(true);
    expect(getFirewallForTest(opA)).toBeNull();
    expect(getFirewallForTest(opB)).toBe(beforeB);
  });

  it("another session's run-level taint never reaches a clean shell call", async () => {
    // A background session contributes taint to the process-wide firewall.
    // The foreground shell call supplies no labels because its own trusted LAX
    // session is clean. LAX adjudicates data flow (hostAdjudicatesDataFlow), so
    // the kernel does not merge the run's labels into it: the call is allowed
    // on the same firewall, with no refresh needed to rescue it.
    const background = await ariEvaluate(
      "memory_search",
      "search",
      { query: "background memory" },
      ["rag"],
    );
    expect(background.allowed).toBe(true);

    const before = getFirewallForTest();
    const foreground = await ariEvaluate("bash", "exec", { command: "git status" }, []);
    expect(foreground.allowed).toBe(true);
    expect(getFirewallForTest()).toBe(before);
    expect(fw()?.isRestricted).not.toBe(true);
  });
});
