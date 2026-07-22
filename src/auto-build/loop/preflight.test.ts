// The preflight's fail details are what the orchestrator's haltReason carries
// and what the parent chat agent diagnoses from. The 2026-07-22 Merchhelm halt
// showed the old details GUESSING ("anchoring or the write gate is broken")
// while the worker's report in stdout named the real cause (tool-policy
// denial). These tests pin that fail details quote the worker's own evidence.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPreflightProbe, PREFLIGHT_FILES } from "./preflight.js";
import type { ChunkAgentResult } from "../agents/chunk-runner.js";

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "lax-preflight-test-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function agentResult(over: Partial<ChunkAgentResult> = {}): ChunkAgentResult {
  return { exitCode: 0, stdout: "", error: undefined, durationMs: 100, ...over } as ChunkAgentResult;
}

const BLOCKED_REPORT = [
  "STATUS: blocked",
  "DONE_WHEN: unmet",
  "CHANGED: none",
  "TESTS: n/a",
  "NEW_FAILURES: none",
  "PRE_EXISTING_FAILURES: none",
  "SPEC_GAPS: none",
  "LAUNCH_READINESS: none",
  "NOTE: write/bash blocked by tool-policy (workspace-write forbidden)",
].join("\n");

describe("runPreflightProbe fail details carry worker evidence", () => {
  it("echo file missing → detail names tool-policy as a candidate AND quotes the worker's NOTE", async () => {
    const res = await runPreflightProbe(
      { projectDir },
      async () => agentResult({ stdout: BLOCKED_REPORT }),
    );
    expect(res.status).toBe("fail");
    if (res.status !== "fail") return;
    expect(res.contract).toBe("file-write-anchoring");
    expect(res.detail).toContain("tool-policy denial");
    expect(res.detail).toContain("STATUS: blocked");
    expect(res.detail).toContain("workspace-write forbidden");
  });

  it("echo file missing with an unparseable worker reply → detail falls back to the output tail", async () => {
    const res = await runPreflightProbe(
      { projectDir },
      async () => agentResult({ stdout: "I could not create the file because policy denied it." }),
    );
    expect(res.status).toBe("fail");
    if (res.status !== "fail") return;
    expect(res.contract).toBe("file-write-anchoring");
    expect(res.detail).toContain("policy denied it");
  });

  it("bash file missing → same evidence treatment on the bash-cwd contract", async () => {
    const res = await runPreflightProbe(
      { projectDir },
      async (opts) => {
        // The runner reads the sentinel the probe wrote, echoes it via the
        // "write" step only — the bash cp step is where the failure happens.
        const token = readFileSync(join(projectDir, PREFLIGHT_FILES.sentinel), "utf-8").trim();
        writeFileSync(join(projectDir, PREFLIGHT_FILES.echo), token + "\n");
        void opts;
        return agentResult({ stdout: BLOCKED_REPORT });
      },
    );
    expect(res.status).toBe("fail");
    if (res.status !== "fail") return;
    expect(res.contract).toBe("bash-cwd");
    expect(res.detail).toContain("workspace-write forbidden");
  });

  it("healthy round-trip still passes", async () => {
    const res = await runPreflightProbe(
      { projectDir },
      async () => {
        const token = readFileSync(join(projectDir, PREFLIGHT_FILES.sentinel), "utf-8").trim();
        writeFileSync(join(projectDir, PREFLIGHT_FILES.echo), token + "\n");
        writeFileSync(join(projectDir, PREFLIGHT_FILES.bash), token + "\n");
        return agentResult({
          stdout: BLOCKED_REPORT.replace("STATUS: blocked", "STATUS: done").replace("DONE_WHEN: unmet", "DONE_WHEN: met"),
        });
      },
    );
    expect(res.status).toBe("pass");
  });
});
