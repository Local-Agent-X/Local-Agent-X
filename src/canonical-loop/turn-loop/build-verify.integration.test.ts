import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBuildVerifyGate, _resetBuildVerifyState } from "./build-verify.js";
import { bashTool } from "../../tools/shell-tool.js";
import { statusOf } from "../../tools/result-helpers.js";
import type { Op } from "../../ops/types.js";

// End-to-end: real filesystem detection + real command execution through the
// same bashTool the model uses (sandbox cage, exit-code→status mapping), no
// model and no mocks. This covers the two layers the unit tests can't — the
// fs probe walking a real directory tree, and a real process exit becoming a
// verdict — which is exactly what a live Grok run exercises when it fires.

let dir: string;
let externalExecSkipReason: string | null = null;

function writeProject(scriptExit: number): void {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fixture", scripts: { typecheck: `exit ${scriptExit}` } }),
  );
}

describe("runBuildVerifyGate — real fs + real exec (integration)", () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "lax-bv-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export const x = 1;\n");
    const probe = await bashTool.execute({ command: "npm --version", _cwd: dir, timeout: 5000 });
    externalExecSkipReason = null;
    if (statusOf(probe) !== "ok") {
      const detail = probe.content.split(/\r?\n/, 1)[0].slice(0, 200);
      externalExecSkipReason = `real build execution unavailable through bashTool: ${detail}`;
    }
  }, 15000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("detects the project's own typecheck script and lets 'done' stand on a clean exit", async (ctx) => {
    if (externalExecSkipReason) ctx.skip(externalExecSkipReason);
    _resetBuildVerifyState();
    writeProject(0);
    const op = { id: "op-integ-green" } as unknown as Op;
    const r = await runBuildVerifyGate(op, { editedPaths: [join(dir, "src", "a.ts")] });
    expect(r.shouldRetry).toBe(false);
    expect(r.nudge).toBe("");
  }, 30000);

  it("runs the real command, maps a non-zero exit to red, and injects the failure", async (ctx) => {
    if (externalExecSkipReason) ctx.skip(externalExecSkipReason);
    _resetBuildVerifyState();
    writeProject(1);
    const op = { id: "op-integ-red" } as unknown as Op;
    const r = await runBuildVerifyGate(op, { editedPaths: [join(dir, "src", "a.ts")] });
    expect(r.shouldRetry).toBe(true);
    expect(r.nudge).toContain("npm run typecheck");
    expect(r.nudge).toContain("FAILING");
  }, 30000);

  it("no buildable project on the real fs → no-op, never fabricates a verdict", async () => {
    _resetBuildVerifyState();
    const bare = mkdtempSync(join(tmpdir(), "lax-bv-bare-"));
    try {
      writeFileSync(join(bare, "notes.txt"), "no manifest here");
      const op = { id: "op-integ-bare" } as unknown as Op;
      const r = await runBuildVerifyGate(op, { editedPaths: [join(bare, "notes.ts")] });
      expect(r.shouldRetry).toBe(false);
      expect(r.nudge).toBe("");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  }, 30000);
});
