// What the host hands the kernel from a preset, and what it keeps for itself.
// The principal is built from HOST_CAPABILITY_MANIFEST, not from the preset's
// capabilities, so a preset's path and host constraints never reach the
// kernel: LAX confines every path through evaluateFileAccess and every URL
// through the network policy, per session and per work root, which a static
// kernel constraint cannot express. That is only honest while the preset the
// host runs declares nothing the host drops — pinned here — and while the
// preset's run-state policy does come through (red team 2026-10-13, A1/A5).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPreset } from "@arikernel/core";
import { ariEvaluate, getFirewallForTest, startAriKernel, stopAriKernel } from "./index.js";

const HOST_PRESET = "workspace-assistant";

describe("the preset the host runs", () => {
  it("declares no path or host constraint the host would drop", () => {
    for (const cap of getPreset(HOST_PRESET).capabilities) {
      const c = cap.constraints ?? {};
      if (c.allowedHosts) expect(c.allowedHosts, cap.toolClass).toEqual(["*"]);
      if (c.allowedPaths) expect(c.allowedPaths, cap.toolClass).toEqual(["./**"]);
      expect(c.allowedCommands, cap.toolClass).toBeUndefined();
    }
  });
});

describe("a preset's run-state policy reaches the kernel", () => {
  let dir = "";
  const prevKey = process.env.LAX_AUDIT_KEY;
  beforeEach(() => {
    process.env.LAX_AUDIT_KEY = "test-host-preset-contract-key-0123456789";
    dir = mkdtempSync(join(tmpdir(), "lax-ari-preset-"));
  });
  afterEach(() => {
    stopAriKernel();
    rmSync(dir, { recursive: true, force: true });
    if (prevKey === undefined) delete process.env.LAX_AUDIT_KEY;
    else process.env.LAX_AUDIT_KEY = prevKey;
  });

  it("strict restricts the run at its own threshold of 3 denials, not the default 5", async () => {
    const threshold = getPreset("strict").runStatePolicy?.maxDeniedSensitiveActions;
    expect(threshold).toBe(3);
    await startAriKernel(join(dir, "audit.db"), "strict", true);
    const restricted = () => (getFirewallForTest() as unknown as { isRestricted?: boolean } | null)?.isRestricted === true;
    for (let i = 1; i <= 3; i++) {
      // deny-shell refuses every shell call under strict; each refusal counts.
      await ariEvaluate("bash", "exec", { command: `echo ${i}` }, []);
      expect(restricted(), `after ${i} denial(s)`).toBe(i >= 3);
    }
  });
});
