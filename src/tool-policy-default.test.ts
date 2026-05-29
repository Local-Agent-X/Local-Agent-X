/**
 * Synthetic policy-default tests.
 *
 * Verifies the TOOL_POLICY_DEFAULTS layer (tool-registry.ts) — synthetic
 * rules derived from each TOOLS entry's risk tier — composes correctly
 * with explicit DEFAULT_POLICY rules.
 *
 * Closes the 2026-05-17 silent-block class: a tool registered in TOOLS
 * with risk:"safe"/workspace-write/network-read now dispatches even when
 * no explicit allow rule exists in default-rules.ts.
 */

import { describe, expect, it } from "vitest";

import { ToolPolicy } from "./tool-policy.js";
import type { ToolPolicyConfig } from "./tool-policy.js";

function emptyPolicy(): ToolPolicy {
  // Empty user rules → only synthetic defaults are present.
  return new ToolPolicy({ defaultDecision: "deny", rules: [] });
}

describe("synthetic policy defaults (TOOL_POLICY_DEFAULTS)", () => {
  it("allows a safe tool with no explicit rule via synthetic fallback", () => {
    // `read` is risk:"safe" in TOOLS → synthetic allow at priority 10.
    const policy = emptyPolicy();
    const result = policy.evaluate("read", { path: "test.txt" }, "test");
    expect(result.allowed).toBe(true);
    expect(result.ruleId).toBe("default-read");
  });

  it("allows a workspace-write tool via synthetic fallback", () => {
    // `memory_save` is risk:"workspace-write" → synthetic allow.
    const policy = emptyPolicy();
    const result = policy.evaluate("memory_save", { key: "x" }, "test");
    expect(result.allowed).toBe(true);
    expect(result.ruleId).toBe("default-memory_save");
  });

  it("leaves a high-risk tool uncovered (hits deny-by-default)", () => {
    // `bash` is risk:"shell" → RISK_TO_DEFAULT has no entry → no synthetic.
    // No user rule either → defaultDecision:"deny" fires.
    const policy = emptyPolicy();
    const result = policy.evaluate("bash", { command: "ls" }, "test");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("default policy");
  });

  it("leaves a destructive tool uncovered", () => {
    // `delete_file` is risk:"destructive" → no synthetic.
    const policy = emptyPolicy();
    const result = policy.evaluate("delete_file", { path: "x" }, "test");
    expect(result.allowed).toBe(false);
  });

  it("leaves a secrets tool uncovered", () => {
    // `list_secrets` is risk:"secrets" → no synthetic.
    const policy = emptyPolicy();
    const result = policy.evaluate("list_secrets", {}, "test");
    expect(result.allowed).toBe(false);
  });

  it("explicit allow rule beats synthetic at lower priority", () => {
    // User rule at priority 50 matches before synthetic at priority 10.
    // findCoveringRule iterates priority desc — explicit wins.
    const config: ToolPolicyConfig = {
      defaultDecision: "deny",
      rules: [
        { id: "user-allow-read", tool: "read", decision: "allow", reason: "explicit", priority: 50 },
      ],
    };
    const policy = new ToolPolicy(config);
    const result = policy.evaluate("read", { path: "x" }, "test");
    expect(result.allowed).toBe(true);
    expect(result.ruleId).toBe("user-allow-read");
  });

  it("explicit deny rule beats synthetic allow", () => {
    // Synthetic allow for `read` (priority 10) loses to explicit deny (priority 90).
    const config: ToolPolicyConfig = {
      defaultDecision: "deny",
      rules: [
        { id: "user-deny-read", tool: "read", decision: "deny", reason: "blocked", priority: 90 },
      ],
    };
    const policy = new ToolPolicy(config);
    const result = policy.evaluate("read", { path: "x" }, "test");
    expect(result.allowed).toBe(false);
    expect(result.ruleId).toBe("user-deny-read");
  });

  it("findCoveringRule reports synthetic id for fallback-covered tools", () => {
    const policy = emptyPolicy();
    const id = policy.findCoveringRule("read");
    expect(id).toBe("default-read");
  });

  it("findCoveringRule returns null for tools with no entry and no synthetic", () => {
    const policy = emptyPolicy();
    const id = policy.findCoveringRule("not_a_real_tool_xyz");
    expect(id).toBeNull();
  });
});
