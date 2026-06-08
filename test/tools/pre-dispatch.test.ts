import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FileExecutor } from "@arikernel/tool-executors";
import { setPreDispatchGate } from "@arikernel/tool-executors";
import type { ToolCall } from "@arikernel/core";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { SecurityLayer } from "../../src/security/index.js";
import { wireAriPreDispatch } from "../../src/server/bootstrap-ari-gate.js";
import * as approvalModule from "../../src/approval-manager.js";
import { assertToolCallAllowed } from "../../src/tools/pre-dispatch.js";

// Regression test for DRY-AUDIT.md F3 — the AriKernel tool dispatcher
// previously skipped LAX's approval/security gates. After this fix, every
// concrete executor calls runPreDispatchGate at the top of execute(), and
// the LAX bootstrap wires that gate to assertToolCallAllowed.

describe("AriKernel pre-dispatch gate (F3 closure)", () => {
  const root = join(tmpdir(), `pre-dispatch-${randomBytes(4).toString("hex")}`);
  const previousRoot = process.env.FILE_EXECUTOR_ROOT;

  beforeEach(() => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "ok.txt"), "hi", "utf-8");
    process.env.FILE_EXECUTOR_ROOT = root;
  });

  afterEach(() => {
    setPreDispatchGate(null);
    if (previousRoot === undefined) delete process.env.FILE_EXECUTOR_ROOT;
    else process.env.FILE_EXECUTOR_ROOT = previousRoot;
    rmSync(root, { recursive: true, force: true });
  });

  function makeCall(action: "read" | "write", overrides: Partial<ToolCall> = {}): ToolCall {
    return {
      id: `tc-${randomBytes(4).toString("hex")}`,
      runId: "test-run",
      sequence: 0,
      timestamp: new Date().toISOString(),
      principalId: "test",
      toolClass: "file",
      action,
      parameters: action === "read"
        ? { path: join(root, "ok.txt") }
        : { path: join(root, "ok.txt"), content: "x" },
      taintLabels: [],
      ...overrides,
    } as ToolCall;
  }

  it("fires assertToolCallAllowed before the executor body runs", async () => {
    const calls: string[] = [];
    setPreDispatchGate(async (tc) => {
      calls.push(`${tc.toolClass}.${tc.action}`);
    });
    const exec = new FileExecutor();
    const res = await exec.execute(makeCall("read"));
    expect(calls).toEqual(["file.read"]);
    expect(res.success).toBe(true);
  });

  it("a deny inside the gate prevents the executor from running", async () => {
    const denyMessage = "BLOCKED by tool-policy: write disabled in test";
    setPreDispatchGate(async () => {
      throw new Error(denyMessage);
    });
    const exec = new FileExecutor();
    await expect(exec.execute(makeCall("write"))).rejects.toThrow(denyMessage);
    // File content stayed at original "hi" (executor body never ran)
    const fs = await import("node:fs");
    expect(fs.readFileSync(join(root, "ok.txt"), "utf-8")).toBe("hi");
  });

  it("wireAriPreDispatch routes the executor through assertToolCallAllowed (security layer fires)", async () => {
    // workspace mode = strict (reads must be inside workspace) so the gate
    // shows up clearly. unrestricted mode would let reads through everywhere.
    const security = new SecurityLayer(root, "workspace");
    wireAriPreDispatch(security);

    // sensitive-file read inside root passes (allowed). A sensitive-named file
    // outside the workspace is blocked by security.evaluate BEFORE the
    // executor body runs — this is the audit gap the fix closes.
    const exec = new FileExecutor();
    await expect(exec.execute(makeCall("read"))).resolves.toMatchObject({ success: true });

    const outsideHome = join(tmpdir(), `outside-${randomBytes(4).toString("hex")}`);
    mkdirSync(outsideHome, { recursive: true });
    writeFileSync(join(outsideHome, "secret.txt"), "data");
    try {
      const call: ToolCall = makeCall("read", {
        parameters: { path: join(outsideHome, "secret.txt") },
      });
      await expect(exec.execute(call)).rejects.toThrow(/BLOCKED by security/);
    } finally {
      rmSync(outsideHome, { recursive: true, force: true });
    }
  });

  it("assertToolCallAllowed throws ToolBlocked when approval is denied", async () => {
    // Direct-call assertion: with the profile gate forced to "ask" and the
    // user denying, the chain throws. Proves the approval branch wires
    // correctly independent of the active profile.
    const spy = vi.spyOn(approvalModule, "getToolDecision").mockReturnValue("ask");
    const approvalMgr = approvalModule.getApprovalManager();
    const original = approvalMgr.requestApproval.bind(approvalMgr);
    const approvalCalls: string[] = [];
    approvalMgr.requestApproval = (async (opts: { toolName: string }) => {
      approvalCalls.push(opts.toolName);
      return false;
    }) as typeof original;
    try {
      await expect(
        assertToolCallAllowed(
          { id: "tc-1", name: "write", args: { path: "/tmp/x" } },
          {
            sessionId: "s",
            callContext: "local",
            approval: { onEvent: () => {} },
          },
        ),
      ).rejects.toThrow(/User declined \(or did not confirm\) write/);
      expect(approvalCalls).toEqual(["write"]);
    } finally {
      approvalMgr.requestApproval = original;
      spy.mockRestore();
    }
  });
});

// Security switches (kill-switches, approval mode, browser mode) may be changed
// when the user asks in an interactive session, but never in an autonomous run
// where no user is present. The autonomous block is the hard guarantee;
// "only when the user asks" is enforced on the prompt side. Regression for the
// self-escalation where a blocked browser call led the agent to re-enable
// enableBrowser and proceed — that now only works in a live, user-driven chat.
describe("protected security settings gate", () => {
  it("allows a security-setting change in an interactive (local) session", async () => {
    await expect(
      assertToolCallAllowed(
        { id: "p1", name: "setting", args: { field: "enableBrowser", value: true } },
        { sessionId: "s", callContext: "local" },
      ),
    ).resolves.toBeUndefined();
  });

  it("denies a security-setting change in an autonomous (cron) run", async () => {
    await expect(
      assertToolCallAllowed(
        { id: "p2", name: "setting", args: { field: "enableShell", value: true } },
        { sessionId: "s", callContext: "cron" },
      ),
    ).rejects.toThrow(/cannot be changed in an automated\/background run/);
  });

  it("denies in a delegated sub-agent run too", async () => {
    await expect(
      assertToolCallAllowed(
        { id: "p3", name: "setting", args: { field: "toolApproval", value: "auto" } },
        { sessionId: "s", callContext: "delegated" },
      ),
    ).rejects.toThrow(/security setting/);
  });

  it("does not gate a non-security setting in an autonomous run", async () => {
    await expect(
      assertToolCallAllowed(
        { id: "p4", name: "setting", args: { field: "theme", value: "dark" } },
        { sessionId: "s", callContext: "cron" },
      ),
    ).resolves.toBeUndefined();
  });
});
