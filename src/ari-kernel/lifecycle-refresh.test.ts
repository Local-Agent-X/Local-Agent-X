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
import { startAriKernel, stopAriKernel, refreshAriKernelRun, refreshAriKernelRunIfStuck } from "./lifecycle.js";
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

  it("is a no-op on a healthy kernel (same firewall instance)", () => {
    const before = getFirewallForTest();
    expect(before).not.toBeNull();
    expect(fw()?.isRestricted).not.toBe(true);
    expect(refreshAriKernelRunIfStuck()).toBe(false);
    expect(getFirewallForTest()).toBe(before); // untouched
  });

  it("reproduces the brick, then clears it at the op boundary", async () => {
    await tripRestricted();
    expect(fw()?.isRestricted).toBe(true);

    // Brick reproduced: a file write is blocked SPECIFICALLY by restricted mode.
    const blocked = await ariEvaluate("write", "write", { path: join(dir, "x.txt"), content: "y" });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toMatch(/restricted mode/i);

    // The fix: the op-boundary guard detects the stuck run and refreshes it.
    const before = getFirewallForTest();
    expect(refreshAriKernelRunIfStuck()).toBe(true);
    const after = getFirewallForTest();
    expect(after).not.toBe(before);        // a fresh Firewall instance
    expect(fw()?.isRestricted).toBe(false);
    expect(fw()?.restrictedAt ?? null).toBeNull();

    // The restricted-mode block is gone. (The write may still be scope/grant
    // limited by the preset — that's fine; it just must not be BRICKED anymore.)
    const after2 = await ariEvaluate("write", "write", { path: join(dir, "x.txt"), content: "y" });
    expect(after2.reason ?? "").not.toMatch(/restricted mode/i);
  });

  it("refreshAriKernelRun replaces the firewall with a fresh run-state", async () => {
    await tripRestricted();
    expect(fw()?.isRestricted).toBe(true);
    const before = getFirewallForTest();

    expect(refreshAriKernelRun()).toBe(true);

    expect(getFirewallForTest()).not.toBe(before);
    expect(fw()?.isRestricted).toBe(false);
  });
});
