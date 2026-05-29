/**
 * Unified tool-policy table tests.
 *
 * The four formerly-scattered policy sources (TOOLS kernel+risk, DEFAULT_POLICY
 * rules, DEFAULT_LIMITS rate caps, the synthetic risk-tier fallback) collapsed
 * into one table (tool-policy/tool-policies.data.ts). These tests assert the
 * two guarantees the refactor must hold:
 *
 *   1. ORPHAN CHECK — every kernel-mapped tool (TOOLS) is reachable by a rule.
 *      No silent risk-tier fallback anymore: a missing rule = deny-by-default,
 *      which this test fails on.
 *   2. BEHAVIOR PARITY — a representative set of (tool, args) decisions matches
 *      the pre-refactor outcomes.
 */

import { describe, expect, it } from "vitest";

import { ToolPolicy, auditPolicyCoverage, type ToolPolicyConfig } from "./tool-policy.js";
import { DEFAULT_POLICY } from "./tool-policy/default-rules.js";
import { deriveRateLimits } from "./tool-policy/tool-policies.js";
import { TOOLS } from "./tool-registry.js";

function defaultPolicy(): ToolPolicy {
  return new ToolPolicy(DEFAULT_POLICY);
}

describe("orphan check — every kernel tool has a policy rule", () => {
  it("leaves no TOOLS entry uncovered by DEFAULT_POLICY", () => {
    const policy = defaultPolicy();
    const report = auditPolicyCoverage(Object.keys(TOOLS), policy);
    expect(report.uncovered, `uncovered tools: ${report.uncovered.join(", ")}`).toEqual([]);
    expect(report.covered.length).toBe(Object.keys(TOOLS).length);
  });

  it("returns null for a tool with no entry and no rule", () => {
    expect(defaultPolicy().findCoveringRule("not_a_real_tool_xyz")).toBeNull();
  });
});

describe("behavior parity — representative decisions match the old table", () => {
  const policy = defaultPolicy();
  const cases: Array<{ tool: string; args: Record<string, unknown>; allowed: boolean; confirm?: boolean; note: string }> = [
    { tool: "read", args: { path: "a.txt" }, allowed: true, note: "allow-read" },
    { tool: "memory_save", args: { key: "x" }, allowed: true, note: "via memory_* glob" },
    { tool: "memory_recall", args: {}, allowed: true, note: "via memory_* glob" },
    { tool: "bash", args: { command: "ls -la" }, allowed: true, note: "allow-bash-limited" },
    { tool: "bash", args: { command: "git status" }, allowed: true, note: "allow-bash-git" },
    { tool: "bash", args: { command: "rm -rf /home" }, allowed: false, note: "deny-bash-rm-rf" },
    { tool: "write", args: { path: "src/a.ts" }, allowed: true, note: "allow-write" },
    { tool: "write", args: { path: "C:\\Windows\\System32\\x" }, allowed: false, note: "deny-write-system" },
    { tool: "edit", args: { path: "node_modules/foo/i.js" }, allowed: false, note: "deny-edit-node-modules" },
    { tool: "delete_file", args: { path: "workspace/x" }, allowed: true, note: "allow-delete-file (destructive but explicit allow)" },
    { tool: "list_secrets", args: {}, allowed: true, note: "allow-list-secrets" },
    { tool: "email_send", args: {}, allowed: true, note: "via email_* glob (external-comms but allowed today)" },
    { tool: "marketplace_install", args: {}, allowed: true, note: "via marketplace_* glob (destructive but allowed today)" },
    { tool: "browser", args: { action: "evaluate" }, allowed: true, confirm: true, note: "flag-browser-evaluate → confirm" },
    // The 15 formerly synthetic-only / uncovered tools, now explicit:
    { tool: "swarm_create", args: {}, allowed: true, note: "was synthetic allow" },
    { tool: "swarm_status", args: {}, allowed: true, note: "was synthetic allow" },
    { tool: "swarm_cancel", args: {}, allowed: false, note: "was uncovered → deny-by-default" },
    { tool: "mission_list", args: {}, allowed: true, note: "was synthetic allow" },
    { tool: "mission_build", args: {}, allowed: true, note: "was synthetic allow" },
    { tool: "mission_delete", args: {}, allowed: false, note: "was uncovered → deny-by-default" },
    { tool: "not_a_real_tool_xyz", args: {}, allowed: false, note: "deny by default policy" },
  ];

  for (const c of cases) {
    it(`${c.tool} ${JSON.stringify(c.args)} → ${c.allowed ? "allow" : "deny"} (${c.note})`, () => {
      const r = policy.evaluate(c.tool, c.args, "test");
      expect(r.allowed).toBe(c.allowed);
      if (c.confirm !== undefined) expect(r.confirm).toBe(c.confirm);
    });
  }
});

describe("rate-limit derivation", () => {
  it("preserves the per-tool + global sliding-window caps", () => {
    const byTool = Object.fromEntries(deriveRateLimits().map((l) => [l.tool, l]));
    expect(byTool.bash).toMatchObject({ maxCalls: 30, windowMs: 60_000, action: "block" });
    expect(byTool.http_request).toMatchObject({ maxCalls: 20, action: "block" });
    expect(byTool.web_fetch).toMatchObject({ maxCalls: 20, action: "block" });
    expect(byTool.write).toMatchObject({ maxCalls: 50, action: "warn" });
    expect(byTool.browser).toMatchObject({ maxCalls: 15, action: "block" });
    expect(byTool["*"]).toMatchObject({ maxCalls: 200, action: "warn" });
  });
});

describe("user rules still override table rules", () => {
  it("explicit deny beats a table allow", () => {
    const config: ToolPolicyConfig = {
      defaultDecision: "deny",
      rules: [{ id: "user-deny-read", tool: "read", decision: "deny", reason: "blocked", priority: 90 }],
    };
    const r = new ToolPolicy(config).evaluate("read", { path: "x" }, "test");
    expect(r.allowed).toBe(false);
    expect(r.ruleId).toBe("user-deny-read");
  });
});
