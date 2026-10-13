// The harness seam: build-verify and spec-probes used to call
// bashTool.execute directly, so a user who switched shell access off still had
// the orchestrator running builds, with no audit record. Both gates are pinned
// here, and the two call sites are pinned to the seam.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const execute = vi.fn(async (_args: Record<string, unknown>) => ({ content: "built", metadata: { status: "ok" } }));
const record = vi.fn();
let enableShell: boolean | undefined = true;

vi.mock("../tools/shell-tool.js", () => ({ bashTool: { execute: (args: Record<string, unknown>) => execute(args) } }));
vi.mock("../tools/result-helpers.js", () => ({ statusOf: (r: { metadata?: { status?: string } }) => r.metadata?.status ?? "ok" }));
vi.mock("../settings.js", () => ({ getSetting: () => enableShell }));
vi.mock("../lax-data-dir.js", () => ({ getLaxDir: () => "/tmp/lax-test" }));
vi.mock("../threat/audit-trail.js", () => ({ getSharedAuditTrail: () => ({ record }) }));

import { executeHarnessCommand } from "./harness-exec.js";

beforeEach(() => {
  execute.mockClear();
  record.mockClear();
  enableShell = true;
});

describe("executeHarnessCommand", () => {
  it("runs the command through bashTool and audits it as allowed", async () => {
    const r = await executeHarnessCommand({ command: "npm run build", cwd: "/p", timeoutMs: 1000, purpose: "build-verify", opId: "op1" });
    expect(r).toEqual({ ok: true, status: "ok", output: "built" });
    expect(execute).toHaveBeenCalledWith({ command: "npm run build", _cwd: "/p", _signal: undefined, timeout: 1000 });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ event: "harness_exec", decision: "allow", sessionId: "op1", reason: "build-verify: npm run build" }));
  });

  it("refuses when the user switched shell access off, and audits the refusal", async () => {
    enableShell = false;
    const r = await executeHarnessCommand({ command: "python probe.py", cwd: "/p", timeoutMs: 1000, purpose: "spec-probe", opId: "op2" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("blocked");
    expect(r.output).toContain("disabled in Settings");
    expect(execute).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ decision: "block", sessionId: "op2" }));
  });

  it("an unset kill switch fails open, like every other gate", async () => {
    enableShell = undefined;
    const r = await executeHarnessCommand({ command: "x", cwd: "/p", timeoutMs: 1, purpose: "build-verify", opId: "op3" });
    expect(r.ok).toBe(true);
  });
});

describe("the two harness call sites use the seam, not bashTool directly", () => {
  const root = join(process.cwd(), "src", "canonical-loop", "turn-loop");
  for (const file of ["build-verify.ts", "spec-probes.ts"]) {
    it(file, () => {
      const text = readFileSync(join(root, file), "utf-8");
      expect(text).toContain("executeHarnessCommand");
      expect(text).not.toMatch(/bashTool\.execute/);
      expect(text).not.toMatch(/from ["']\.\.\/\.\.\/tools\/shell-tool\.js["']/);
    });
  }
});
