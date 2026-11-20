/**
 * The Settings switches for shell, HTTP and browser: each flips the decision
 * of one rule in tool-policy.json. The policy file's one reader and writer is
 * this module; LiveToolPolicy (index.ts) picks the write up through its watcher.
 *
 * A missing file starts from the stamped defaults, the same policy the server
 * writes on first run, so a switch flipped before the first load does not
 * leave a file holding one rule and a default the code never shipped.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "../util/json-store.js";
import { stampedDefaultPolicy } from "./merge-defaults.js";
import type { ToolPolicyConfig } from "./types.js";

export type PolicyToggle = "bash" | "http" | "browser";

const RULE_FOR: Record<PolicyToggle, { id: string; tool: string }> = {
  bash: { id: "allow-bash-limited", tool: "bash" },
  http: { id: "allow-http-limited", tool: "http_request" },
  browser: { id: "allow-browser", tool: "browser" },
};

export function isPolicyToggle(name: unknown): name is PolicyToggle {
  return typeof name === "string" && Object.hasOwn(RULE_FOR, name);
}

function readPolicy(dataDir: string): ToolPolicyConfig {
  const path = join(dataDir, "tool-policy.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) as ToolPolicyConfig : stampedDefaultPolicy();
}

/** Whether each switch is on: its rule is absent or not a deny. */
export function policyToggleStates(dataDir: string): Record<PolicyToggle, boolean> {
  const rules = readPolicy(dataDir).rules;
  const on = (t: PolicyToggle) => rules.find((r) => r.id === RULE_FOR[t].id)?.decision !== "deny";
  return { bash: on("bash"), http: on("http"), browser: on("browser") };
}

export function setPolicyToggle(dataDir: string, toggle: PolicyToggle, enabled: boolean): void {
  const policy = readPolicy(dataDir);
  const { id, tool } = RULE_FOR[toggle];
  const decision = enabled ? "allow" : "deny";
  const rule = policy.rules.find((r) => r.id === id);
  if (rule) rule.decision = decision;
  else policy.rules.push({ id, tool, decision, reason: enabled ? "Enabled via settings" : "Disabled via settings", priority: 40 });
  atomicWriteFileSync(join(dataDir, "tool-policy.json"), JSON.stringify(policy, null, 2), { encoding: "utf-8", mode: 0o600 });
}
