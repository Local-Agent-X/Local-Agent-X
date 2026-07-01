// Cross-seam CONTRACT test for the tainted-shell pre-gate (enforce-policy.ts).
//
// LAX pre-empts the kernel's deny-tainted-shell so its web_taint_sensitive_probe
// quarantine (which also blocks file WRITES) never fires. That duplicates the
// kernel's "shell + web/rag/email taint → deny" decision at the LAX layer, so
// this test pins the two seams together:
//   1. taintedShellBlockReason agrees with the live kernel on when a tainted
//      shell is denied (drift guard — if the kernel rule changes, this fails).
//   2. The fix's VALUE: pre-gating (not calling the kernel for the tainted shell)
//      leaves the run un-quarantined, so a subsequent file write still works —
//      whereas letting the kernel see it bricks the write.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAriKernel, stopAriKernel } from "../ari-kernel/lifecycle.js";
import { getFirewallForTest } from "../ari-kernel/state.js";
import { ariEvaluate } from "../ari-kernel/evaluate.js";
import { taintedShellBlockReason } from "./enforce-policy.js";

/** Live firewall narrowed to the restricted-mode getter we assert on. */
function isRestricted(): boolean {
  return (getFirewallForTest() as unknown as { isRestricted?: boolean } | null)?.isRestricted === true;
}

describe("tainted-shell pre-gate — pure decision", () => {
  it("blocks a shell tool under web/rag/email taint, allows otherwise", () => {
    expect(taintedShellBlockReason("bash", ["web"])).not.toBeNull();
    expect(taintedShellBlockReason("bash", ["rag"])).not.toBeNull();
    expect(taintedShellBlockReason("bash", ["email"])).not.toBeNull();
    expect(taintedShellBlockReason("process_start", ["web"])).not.toBeNull(); // shell-class too
    // user-provided is the trusted source — kernel keeps it OUT of the deny set.
    expect(taintedShellBlockReason("bash", ["user-provided"])).toBeNull();
    expect(taintedShellBlockReason("bash", [])).toBeNull();
    // Non-shell tools are never blocked by THIS gate (egress has its own guards).
    expect(taintedShellBlockReason("read", ["web"])).toBeNull();
    expect(taintedShellBlockReason("http_request", ["web"])).toBeNull();
  });

  it("names the offending taint sources in the message", () => {
    const msg = taintedShellBlockReason("bash", ["rag", "user-provided"]);
    expect(msg).toContain("rag");
    expect(msg).not.toContain("user-provided"); // only the deny-set sources are named
  });
});

describe("tainted-shell pre-gate — kernel contract + write-preservation", () => {
  let dir: string;
  const prevKey = process.env.LAX_AUDIT_KEY;

  beforeEach(async () => {
    process.env.LAX_AUDIT_KEY = "test-ari-taint-shell-key-0123456789ab";
    dir = mkdtempSync(join(tmpdir(), "lax-taint-shell-"));
    await startAriKernel(join(dir, "ari-audit.db"), "workspace-assistant", true);
  });
  afterEach(() => {
    stopAriKernel();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (prevKey === undefined) delete process.env.LAX_AUDIT_KEY;
    else process.env.LAX_AUDIT_KEY = prevKey;
  });

  it("agrees with the live kernel: a web-tainted shell IS denied (and would quarantine the run)", async () => {
    // The helper says block:
    expect(taintedShellBlockReason("bash", ["web"])).not.toBeNull();
    // The live kernel agrees — denies it — AND (the reason we pre-empt) quarantines:
    const r = await ariEvaluate("bash", "exec", { command: "git status" }, ["web"]);
    expect(r.allowed).toBe(false);
    expect(isRestricted()).toBe(true);
  });

  it("THE FIX: skipping the kernel for a tainted shell keeps file writes working", async () => {
    // Old path — kernel sees the tainted shell → run quarantined → write bricked:
    const shell = await ariEvaluate("bash", "exec", { command: "git status" }, ["web"]);
    expect(shell.allowed).toBe(false);
    const bricked = await ariEvaluate("write", "write", { path: join(dir, "a.ts"), content: "x" });
    expect(bricked.allowed).toBe(false);
    expect(bricked.reason).toMatch(/restricted mode|quarantin/i);
  });

  it("THE FIX: the pre-gate denies the shell WITHOUT touching the kernel, so writes survive", async () => {
    // New path — the gate returns the block from taintedShellBlockReason and never
    // calls ariEvaluate for the shell, so the kernel never quarantines. Simulate
    // exactly that: assert the pre-gate fires, then that a write is NOT bricked.
    expect(taintedShellBlockReason("bash", ["web"])).not.toBeNull(); // gate denies here; kernel NOT called
    const write = await ariEvaluate("write", "write", { path: join(dir, "a.ts"), content: "x" });
    expect(write.reason ?? "").not.toMatch(/restricted mode|quarantin/i);
  });
});
