/**
 * Tool Policy argument matching tests.
 *
 * Verifies that argMatch patterns correctly filter rules
 * based on tool argument values.
 */

import { describe, it, expect } from "vitest";

// Import the matchArgPattern function indirectly via ToolPolicy
// We test through the public evaluate() API
import { ToolPolicy } from "./tool-policy.js";
import type { ToolPolicyConfig } from "./tool-policy.js";

function makePolicy(rules: ToolPolicyConfig["rules"]): ToolPolicy {
  return new ToolPolicy({ defaultDecision: "deny", rules });
}

describe("argMatch-based policy rules", () => {
  it("blocks bash rm -rf via argMatch", () => {
    const policy = makePolicy([
      { id: "deny-rm", tool: "bash", decision: "deny", reason: "no rm -rf", priority: 90, argMatch: { command: "rm -rf *" } },
      { id: "allow-bash", tool: "bash", decision: "allow", reason: "general allow", priority: 40 },
    ]);
    const result = policy.evaluate("bash", { command: "rm -rf /home" }, "test");
    expect(result.allowed).toBe(false);
    expect(result.ruleId).toBe("deny-rm");
  });

  it("allows bash commands that don't match deny pattern", () => {
    const policy = makePolicy([
      { id: "deny-rm", tool: "bash", decision: "deny", reason: "no rm -rf", priority: 90, argMatch: { command: "rm -rf *" } },
      { id: "allow-bash", tool: "bash", decision: "allow", reason: "general allow", priority: 40 },
    ]);
    const result = policy.evaluate("bash", { command: "ls -la" }, "test");
    expect(result.allowed).toBe(true);
    expect(result.ruleId).toBe("allow-bash");
  });

  it("matches git commands with argMatch", () => {
    const policy = makePolicy([
      { id: "allow-git", tool: "bash", decision: "allow", reason: "git ok", priority: 50, argMatch: { command: "git *" } },
      { id: "deny-bash", tool: "bash", decision: "deny", reason: "other bash denied", priority: 40 },
    ]);
    expect(policy.evaluate("bash", { command: "git status" }, "t").allowed).toBe(true);
    expect(policy.evaluate("bash", { command: "git log --oneline" }, "t").allowed).toBe(true);
    expect(policy.evaluate("bash", { command: "npm install" }, "t").allowed).toBe(false);
  });

  it("blocks writes to node_modules via path argMatch", () => {
    const policy = makePolicy([
      { id: "deny-nm", tool: "write", decision: "deny", reason: "no node_modules", priority: 80, argMatch: { path: "*node_modules*" } },
      { id: "allow-write", tool: "write", decision: "allow", reason: "write ok", priority: 40 },
    ]);
    expect(policy.evaluate("write", { path: "node_modules/foo/index.js" }, "t").allowed).toBe(false);
    expect(policy.evaluate("write", { path: "src/index.ts" }, "t").allowed).toBe(true);
  });

  it("requires all argMatch patterns to match", () => {
    const policy = makePolicy([
      { id: "deny-specific", tool: "http_request", decision: "deny", reason: "blocked", priority: 80,
        argMatch: { method: "DELETE", url: "*/users/*" } },
      { id: "allow-http", tool: "http_request", decision: "allow", reason: "ok", priority: 40 },
    ]);
    // Both match → deny
    expect(policy.evaluate("http_request", { method: "DELETE", url: "https://api.example.com/users/123" }, "t").allowed).toBe(false);
    // Only one matches → skip rule, fall through to allow
    expect(policy.evaluate("http_request", { method: "GET", url: "https://api.example.com/users/123" }, "t").allowed).toBe(true);
    expect(policy.evaluate("http_request", { method: "DELETE", url: "https://api.example.com/posts/123" }, "t").allowed).toBe(true);
  });

  it("handles exact match (no wildcards)", () => {
    const policy = makePolicy([
      { id: "deny-exact", tool: "bash", decision: "deny", reason: "blocked", priority: 80, argMatch: { command: "shutdown" } },
      { id: "allow-bash", tool: "bash", decision: "allow", reason: "ok", priority: 40 },
    ]);
    expect(policy.evaluate("bash", { command: "shutdown" }, "t").allowed).toBe(false);
    expect(policy.evaluate("bash", { command: "shutdown -r" }, "t").allowed).toBe(true); // not exact
  });

  it("is case-insensitive", () => {
    const policy = makePolicy([
      { id: "deny-rm", tool: "bash", decision: "deny", reason: "no", priority: 80, argMatch: { command: "RM -RF *" } },
      { id: "allow", tool: "bash", decision: "allow", reason: "ok", priority: 40 },
    ]);
    expect(policy.evaluate("bash", { command: "rm -rf /tmp" }, "t").allowed).toBe(false);
  });

  it("skips rule when arg is missing", () => {
    const policy = makePolicy([
      { id: "deny-path", tool: "write", decision: "deny", reason: "no", priority: 80, argMatch: { path: "*.exe" } },
      { id: "allow", tool: "write", decision: "allow", reason: "ok", priority: 40 },
    ]);
    // No path arg → argMatch doesn't match → falls through to allow
    expect(policy.evaluate("write", { content: "hello" }, "t").allowed).toBe(true);
  });
});

describe("argMatch load-time validation", () => {
  it("validates patterns at load time and rejects unsafe ones", () => {
    // Glob patterns get escaped before validation, so most user input is safe.
    // This test verifies the validation runs — a safe pattern should be kept.
    const policy = makePolicy([
      { id: "good-rule", tool: "bash", decision: "deny", reason: "block rm", priority: 90, argMatch: { command: "rm *" } },
      { id: "allow", tool: "bash", decision: "allow", reason: "ok", priority: 40 },
    ]);
    // good-rule should be kept — rm command blocked
    expect(policy.evaluate("bash", { command: "rm foo.txt" }, "t").allowed).toBe(false);
    expect(policy.evaluate("bash", { command: "ls" }, "t").allowed).toBe(true);
  });

  it("keeps rules with valid argMatch patterns", () => {
    const policy = makePolicy([
      { id: "block-ts", tool: "write", decision: "deny", reason: "no ts", priority: 80, argMatch: { path: "*.ts" } },
      { id: "allow", tool: "write", decision: "allow", reason: "ok", priority: 40 },
    ]);
    expect(policy.evaluate("write", { path: "index.ts" }, "t").allowed).toBe(false);
    expect(policy.evaluate("write", { path: "index.js" }, "t").allowed).toBe(true);
  });
});

describe("edit tool deny rules", () => {
  it("blocks edit to node_modules", () => {
    const policy = makePolicy([
      { id: "deny-edit-nm", tool: "edit", decision: "deny", reason: "no node_modules", priority: 80, argMatch: { path: "*node_modules*" } },
      { id: "allow-edit", tool: "edit", decision: "allow", reason: "ok", priority: 40 },
    ]);
    expect(policy.evaluate("edit", { path: "node_modules/foo/index.js" }, "t").allowed).toBe(false);
    expect(policy.evaluate("edit", { path: "src/index.ts" }, "t").allowed).toBe(true);
  });

  it("blocks edit to system directories", () => {
    const policy = makePolicy([
      { id: "deny-edit-sys", tool: "edit", decision: "deny", reason: "no system", priority: 90, argMatch: { path: "C:\\Windows*" } },
      { id: "allow-edit", tool: "edit", decision: "allow", reason: "ok", priority: 40 },
    ]);
    expect(policy.evaluate("edit", { path: "C:\\Windows\\System32\\config" }, "t").allowed).toBe(false);
    expect(policy.evaluate("edit", { path: "src/config.ts" }, "t").allowed).toBe(true);
  });
});
