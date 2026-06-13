/**
 * Full gate-chain regression test for external MCP tools.
 *
 * MCP server tools (mcp_<server>_<tool>) register at runtime and are absent
 * from the static TOOLS table, so EVERY default-deny gate had to be taught
 * about them independently. Each gate has its own unit test; this one asserts
 * they all allow the SAME representative MCP call together, so a future change
 * to any single gate that re-breaks the MCP surface is caught here.
 *
 * The four policy gates a tool call passes (see enforce-policy.ts:enforcePolicyPhase):
 *   1. Autonomy profile      (classifyToolRisk + decide)
 *   2. ARI kernel            (ariEvaluate)
 *   3. Tool-policy           (loadToolPolicy().evaluate)
 *   4. SecurityLayer         (evaluateByKernelClass via SecurityLayer.evaluate)
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const READ_TOOL = "mcp_github_search_repositories";
const WRITE_TOOL = "mcp_github_create_issue";

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "mcp-chain-"));
  tmpDirs.push(d);
  return d;
}

afterEach(async () => {
  const { stopAriKernel } = await import("../src/ari-kernel/index.js");
  stopAriKernel();
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe("MCP tools pass every default-deny gate", () => {
  for (const tool of [READ_TOOL, WRITE_TOOL]) {
    it(`${tool}: autonomy profile does not deny`, async () => {
      const { classifyToolRisk } = await import("../src/autonomy/risk.js");
      const { getProfile, decide } = await import("../src/autonomy/profiles.js");
      const decision = decide(getProfile("Normal"), classifyToolRisk(tool));
      expect(decision).not.toBe("deny");
    });

    it(`${tool}: ARI kernel allows on a clean session`, async () => {
      const { startAriKernel, ariEvaluate } = await import("../src/ari-kernel/index.js");
      await startAriKernel(join(tmp(), "audit.db"), "workspace-assistant", true);
      const r = await ariEvaluate(tool, "exec", { query: "x", title: "x" });
      expect(r.reason).not.toMatch(/not in TOOL_CLASS_MAP/i);
      expect(r.allowed, `kernel denied: ${r.reason}`).toBe(true);
    });

    it(`${tool}: tool-policy allows via the mcp_* glob`, async () => {
      // Exercise the real merge (which injects the default rules, incl. the
      // mcp_* glob) without loadToolPolicy's file watcher — a fresh install has
      // no user rules, so defaults supply allow-mcp.
      const { ToolPolicy, mergeWithDefaults } = await import("../src/tool-policy.js");
      const tp = new ToolPolicy(mergeWithDefaults({ defaultDecision: "deny", rules: [] }));
      const d = tp.evaluate(tool, {}, "default");
      expect(d.allowed, `tool-policy denied: ${d.reason}`).toBe(true);
    });

    it(`${tool}: SecurityLayer allows (http-class, no url)`, async () => {
      const { SecurityLayer } = await import("../src/security/index.js");
      const sec = new SecurityLayer(tmp(), "workspace");
      const d = sec.evaluate({ toolName: tool, args: { query: "x", title: "x" }, sessionId: "t" });
      expect(d.reason).not.toMatch(/not in registry/i);
      expect(d.allowed, `security denied: ${d.reason}`).toBe(true);
    });
  }
});
