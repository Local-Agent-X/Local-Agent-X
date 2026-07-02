/**
 * Preflight probe — the loop's start-time environment-contract check.
 *
 * Regression class (Jul 2026 food-truck-tracker rounds 1-5): every failed
 * run traced to a harness↔worker contract break (path anchoring, delegated
 * write gate, bash cwd, report shape) that only surfaced as a 30-minute
 * chunk flail. The probe must name the broken contract in ~1 minute, and a
 * healthy environment must pass cleanly with no probe files left behind.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPreflightProbe, PREFLIGHT_FILES } from "../src/auto-build/loop/preflight.js";
import type { ChunkAgentInvocation, ChunkAgentResult } from "../src/auto-build/agents/chunk-runner.js";

const REPORT = (note: string) =>
  `STATUS: done\nDONE_WHEN: met\nCHANGED: ${PREFLIGHT_FILES.echo}, ${PREFLIGHT_FILES.bash}\n` +
  `TESTS: n/a\nNEW_FAILURES: none\nPRE_EXISTING_FAILURES: none\nSPEC_GAPS: none\n` +
  `LAUNCH_READINESS: none\nNOTE: preflight token ${note}`;

function ok(result: Partial<ChunkAgentResult> = {}): ChunkAgentResult {
  return { stdout: "", exitCode: 0, durationMs: 10, ...result };
}

describe("runPreflightProbe", () => {
  let dir: string;
  const token = () => readFileSync(join(dir, PREFLIGHT_FILES.sentinel), "utf-8").trim();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "auto-build-preflight-"));
    delete process.env.LAX_BUILD_PREFLIGHT;
  });
  afterEach(() => {
    delete process.env.LAX_BUILD_PREFLIGHT;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* win file locks */ }
  });

  it("passes when the worker round-trips the token through read, write, and bash", async () => {
    let seenTask = "";
    const r = await runPreflightProbe({ projectDir: dir }, async (opts: ChunkAgentInvocation) => {
      seenTask = opts.task;
      const t = token();
      writeFileSync(join(dir, PREFLIGHT_FILES.echo), t);
      writeFileSync(join(dir, PREFLIGHT_FILES.bash), t);
      return ok({ stdout: REPORT(t) });
    });
    expect(r.status).toBe("pass");
    // The task hands the worker a forward-slash root — the backslash-loss class.
    expect(seenTask).not.toContain("\\");
    // No probe debris survives — nothing for the chunk-1 sweep to pick up.
    for (const f of Object.values(PREFLIGHT_FILES)) {
      expect(existsSync(join(dir, f))).toBe(false);
    }
  });

  it("names worker-invocation when the agent run fails", async () => {
    const r = await runPreflightProbe({ projectDir: dir }, async () =>
      ok({ exitCode: 1, error: "delegated bash requires worktree isolation" }));
    expect(r).toMatchObject({ status: "fail", contract: "worker-invocation" });
    expect((r as { detail: string }).detail).toContain("worktree isolation");
  });

  it("names worker-timeout on exit 124", async () => {
    const r = await runPreflightProbe({ projectDir: dir }, async () =>
      ok({ exitCode: 124, error: "chunk agent timed out after 300000ms" }));
    expect(r).toMatchObject({ status: "fail", contract: "worker-timeout" });
  });

  it("names report-shape when the final message has no report block", async () => {
    const r = await runPreflightProbe({ projectDir: dir }, async () => {
      const t = token();
      writeFileSync(join(dir, PREFLIGHT_FILES.echo), t);
      writeFileSync(join(dir, PREFLIGHT_FILES.bash), t);
      return ok({ stdout: "I have completed the preflight steps successfully!" });
    });
    expect(r).toMatchObject({ status: "fail", contract: "report-shape" });
  });

  it("names file-write-anchoring when the relative write never lands", async () => {
    const r = await runPreflightProbe({ projectDir: dir }, async () => ok({ stdout: REPORT("x") }));
    expect(r).toMatchObject({ status: "fail", contract: "file-write-anchoring" });
  });

  it("names file-read-anchoring when the echoed token is wrong", async () => {
    const r = await runPreflightProbe({ projectDir: dir }, async () => {
      writeFileSync(join(dir, PREFLIGHT_FILES.echo), "not-the-token");
      return ok({ stdout: REPORT("not-the-token") });
    });
    expect(r).toMatchObject({ status: "fail", contract: "file-read-anchoring" });
  });

  it("names bash-cwd when the bash copy never lands", async () => {
    const r = await runPreflightProbe({ projectDir: dir }, async () => {
      const t = token();
      writeFileSync(join(dir, PREFLIGHT_FILES.echo), t);
      return ok({ stdout: REPORT(t) });
    });
    expect(r).toMatchObject({ status: "fail", contract: "bash-cwd" });
  });

  it("cleans up probe files even when the verdict is fail", async () => {
    await runPreflightProbe({ projectDir: dir }, async () => {
      writeFileSync(join(dir, PREFLIGHT_FILES.echo), "wrong");
      return ok({ stdout: REPORT("wrong") });
    });
    for (const f of Object.values(PREFLIGHT_FILES)) {
      expect(existsSync(join(dir, f))).toBe(false);
    }
  });

  it("skips without invoking the worker when LAX_BUILD_PREFLIGHT=0", async () => {
    process.env.LAX_BUILD_PREFLIGHT = "0";
    let invoked = false;
    const r = await runPreflightProbe({ projectDir: dir }, async () => {
      invoked = true;
      return ok();
    });
    expect(r.status).toBe("skipped");
    expect(invoked).toBe(false);
    expect(existsSync(join(dir, PREFLIGHT_FILES.sentinel))).toBe(false);
  });
});
