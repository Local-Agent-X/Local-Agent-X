import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPolicyToggle, policyToggleStates, setPolicyToggle } from "./toggles.js";
import { stampedDefaultPolicy } from "./merge-defaults.js";
import type { ToolPolicyConfig } from "./types.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "policy-toggles-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const read = (): ToolPolicyConfig => JSON.parse(readFileSync(join(dir, "tool-policy.json"), "utf-8"));

describe("Settings switches for shell, HTTP and browser", () => {
  it("a switch flipped before the policy file exists starts from the shipped defaults", () => {
    setPolicyToggle(dir, "bash", false);
    const written = read();
    const shipped = stampedDefaultPolicy();
    expect(written.defaultDecision).toBe(shipped.defaultDecision);
    expect(written.rules.length).toBe(shipped.rules.length);
    expect(written.rules.find((r) => r.id === "allow-bash-limited")?.decision).toBe("deny");
    expect(policyToggleStates(dir)).toEqual({ bash: false, http: true, browser: true });
  });

  it("flips the existing rule and keeps the user's other rules", () => {
    writeFileSync(join(dir, "tool-policy.json"), JSON.stringify({
      defaultDecision: "deny",
      rules: [{ id: "mine", tool: "read", decision: "allow" }, { id: "allow-http-limited", tool: "http_request", decision: "deny" }],
    }));
    setPolicyToggle(dir, "http", true);
    const rules = read().rules;
    expect(rules.find((r) => r.id === "allow-http-limited")?.decision).toBe("allow");
    expect(rules.find((r) => r.id === "mine")?.decision).toBe("allow");
  });

  it("adds the rule under its tool's name when the file lacks it", () => {
    writeFileSync(join(dir, "tool-policy.json"), JSON.stringify({ defaultDecision: "deny", rules: [] }));
    setPolicyToggle(dir, "http", false);
    expect(read().rules).toEqual([expect.objectContaining({ id: "allow-http-limited", tool: "http_request", decision: "deny" })]);
  });

  it("knows only the three switches", () => {
    expect(["bash", "http", "browser"].every(isPolicyToggle)).toBe(true);
    expect(isPolicyToggle("toString")).toBe(false);
    expect(isPolicyToggle("computer")).toBe(false);
  });
});
