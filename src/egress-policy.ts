/**
 * Network Egress Policy
 *
 * Domain whitelist/blacklist for outbound requests.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface EgressRule {
  domain: string;
  action: "allow" | "block";
  reason?: string;
  addedAt: string;
}

interface EgressPolicyStore {
  mode: "allowlist" | "blocklist" | "permissive";
  rules: EgressRule[];
}

const POLICY_FILE = join(homedir(), ".lax", "egress-policy.json");

function ensureDir(): void {
  const dir = join(homedir(), ".lax");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function loadPolicy(): EgressPolicyStore {
  if (!existsSync(POLICY_FILE)) {
    return { mode: "permissive", rules: [] };
  }
  try {
    return JSON.parse(readFileSync(POLICY_FILE, "utf-8"));
  } catch {
    return { mode: "permissive", rules: [] };
  }
}

function savePolicy(policy: EgressPolicyStore): void {
  ensureDir();
  writeFileSync(POLICY_FILE, JSON.stringify(policy, null, 2), "utf-8");
}

/** Get current egress policy mode */
export function getEgressMode(): "allowlist" | "blocklist" | "permissive" {
  return loadPolicy().mode;
}

/** Set egress policy mode */
export function setEgressMode(mode: "allowlist" | "blocklist" | "permissive"): void {
  const policy = loadPolicy();
  policy.mode = mode;
  savePolicy(policy);
}

/** List all egress rules */
export function listEgressRules(): EgressRule[] {
  return loadPolicy().rules;
}

/** Add an egress rule */
export function addEgressRule(domain: string, action: "allow" | "block", reason?: string): EgressRule {
  const policy = loadPolicy();
  const rule: EgressRule = {
    domain: domain.toLowerCase(),
    action,
    reason,
    addedAt: new Date().toISOString(),
  };
  // Remove existing rule for same domain
  policy.rules = policy.rules.filter(r => r.domain !== rule.domain);
  policy.rules.push(rule);
  savePolicy(policy);
  return rule;
}

/** Remove an egress rule by domain */
export function removeEgressRule(domain: string): boolean {
  const policy = loadPolicy();
  const before = policy.rules.length;
  policy.rules = policy.rules.filter(r => r.domain !== domain.toLowerCase());
  if (policy.rules.length === before) return false;
  savePolicy(policy);
  return true;
}

/** Check if a domain is allowed by the egress policy */
export function checkEgress(hostname: string): { allowed: boolean; reason: string } {
  const policy = loadPolicy();
  const host = hostname.toLowerCase();

  if (policy.mode === "permissive") {
    // In permissive mode, only explicit blocks apply
    const blockRule = policy.rules.find(r => r.action === "block" && matchesDomain(host, r.domain));
    if (blockRule) {
      return { allowed: false, reason: `Blocked by egress policy: ${blockRule.reason || blockRule.domain}` };
    }
    return { allowed: true, reason: "Permissive mode — allowed" };
  }

  if (policy.mode === "allowlist") {
    // Only explicitly allowed domains
    const allowRule = policy.rules.find(r => r.action === "allow" && matchesDomain(host, r.domain));
    if (allowRule) {
      return { allowed: true, reason: `Allowed by egress allowlist: ${allowRule.domain}` };
    }
    return { allowed: false, reason: `Blocked: ${host} not in egress allowlist` };
  }

  if (policy.mode === "blocklist") {
    // Everything allowed except explicitly blocked
    const blockRule = policy.rules.find(r => r.action === "block" && matchesDomain(host, r.domain));
    if (blockRule) {
      return { allowed: false, reason: `Blocked by egress blocklist: ${blockRule.reason || blockRule.domain}` };
    }
    return { allowed: true, reason: "Not in blocklist — allowed" };
  }

  return { allowed: true, reason: "Unknown mode — defaulting to allow" };
}

/** Match a hostname against a domain rule (supports wildcards like *.example.com) */
function matchesDomain(hostname: string, rule: string): boolean {
  hostname = hostname.toLowerCase();
  rule = rule.toLowerCase();
  if (rule.startsWith("*.")) {
    return hostname === rule.slice(2) || hostname.endsWith(rule.slice(1));
  }
  return hostname === rule;
}

/** Bulk import egress rules */
export function importEgressRules(rules: Array<{ domain: string; action: "allow" | "block"; reason?: string }>): number {
  let count = 0;
  for (const r of rules) {
    addEgressRule(r.domain, r.action, r.reason);
    count++;
  }
  return count;
}

/** Export egress policy as JSON */
export function exportEgressPolicy(): string {
  return JSON.stringify(loadPolicy(), null, 2);
}
