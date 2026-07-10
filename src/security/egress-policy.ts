/**
 * Network Egress Policy
 *
 * Domain whitelist/blacklist for outbound requests.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { USER_HINTS } from "../types.js";
import { getLaxDir } from "../lax-data-dir.js";

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

const POLICY_FILE = join(getLaxDir(), "egress-policy.json");

function ensureDir(): void {
  const dir = getLaxDir();
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

/**
 * strictLocalOnly (config.json): the hard local-only switch. Read at call time
 * (never cached at module load) directly from <laxDir>/config.json — the same
 * no-side-effect pattern as security-config.ts's ollamaLoopbackPort, so the
 * security layer never imports config.ts (which starts watchers on import).
 * Consulted by every egress enforcement point (network-policy evaluateWebFetch
 * — the choke point all web_fetch/http_request/browser/redirect checks flow
 * through), by checkEgress below, by the cloud-credential seam (auth/resolve),
 * and by the cloud OAuth routes.
 */
export function isStrictLocalOnly(): boolean {
  try {
    const cfgPath = join(getLaxDir(), "config.json");
    if (!existsSync(cfgPath)) return false;
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    return cfg.strictLocalOnly === true;
  } catch {
    return false;
  }
}

/** The stored mode, overridden to "allowlist" while strictLocalOnly is on —
 *  the flag behaves as an implicit allowlist containing only local hosts. */
export function getEffectiveEgressMode(): "allowlist" | "blocklist" | "permissive" {
  if (isStrictLocalOnly()) return "allowlist";
  return getEgressMode();
}

/** Loopback (127/8, ::1, localhost) or RFC1918 LAN-local literal. Deliberately
 *  NARROWER than ip-classification's isPrivateIPv4: link-local / cloud-metadata
 *  (169.254.0.0/16) is "private" there but must never count as local-ALLOWED. */
function isLoopbackOrRfc1918(host: string): boolean {
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

/** Tool-seam refusal for the public-search tools (web_search / image_search),
 *  whose provider fetches go straight to search-engine APIs and never pass the
 *  evaluateWebFetch choke point. Null when the flag is off — the tools run
 *  unchanged. Matches the tools' `{ content: "Error: ...", isError }` shape. */
export function strictLocalOnlySearchRefusal(toolName: string): { content: string; isError: true } | null {
  if (!isStrictLocalOnly()) return null;
  return {
    content: `Error: ${toolName} is disabled — strictLocalOnly is enabled (config.json); public search providers are non-local egress.`,
    isError: true,
  };
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
export function checkEgress(hostname: string): { allowed: boolean; reason: string; userHint?: string } {
  const host = hostname.toLowerCase();

  // strictLocalOnly overrides the stored mode AND the per-domain rules: only
  // loopback / RFC1918 LAN-local literals pass. The local model endpoint
  // qualifies through the loopback rule — there is deliberately NO carve-out
  // keyed on config.json's ollamaUrl host: the agent can write config.json,
  // so a poisoned ollamaUrl (http://attacker.com) must never whitelist a
  // public host. Same validate-as-loopback hardening as ollamaPortFromUrl
  // (security-config.ts).
  if (isStrictLocalOnly()) {
    if (isLoopbackOrRfc1918(host)) {
      return { allowed: true, reason: "strictLocalOnly — local host allowed" };
    }
    return {
      allowed: false,
      reason: `Blocked: ${host} — strictLocalOnly is enabled (config.json); only loopback, LAN-local (RFC1918), and the local model endpoint are reachable`,
      userHint: USER_HINTS.network,
    };
  }

  const policy = loadPolicy();

  if (policy.mode === "permissive") {
    // In permissive mode, only explicit blocks apply
    const blockRule = policy.rules.find(r => r.action === "block" && matchesDomain(host, r.domain));
    if (blockRule) {
      return { allowed: false, reason: `Blocked by egress policy: ${blockRule.reason || blockRule.domain}`, userHint: USER_HINTS.network };
    }
    return { allowed: true, reason: "Permissive mode — allowed" };
  }

  if (policy.mode === "allowlist") {
    // Only explicitly allowed domains
    const allowRule = policy.rules.find(r => r.action === "allow" && matchesDomain(host, r.domain));
    if (allowRule) {
      return { allowed: true, reason: `Allowed by egress allowlist: ${allowRule.domain}` };
    }
    return { allowed: false, reason: `Blocked: ${host} not in egress allowlist`, userHint: USER_HINTS.network };
  }

  if (policy.mode === "blocklist") {
    // Everything allowed except explicitly blocked
    const blockRule = policy.rules.find(r => r.action === "block" && matchesDomain(host, r.domain));
    if (blockRule) {
      return { allowed: false, reason: `Blocked by egress blocklist: ${blockRule.reason || blockRule.domain}`, userHint: USER_HINTS.network };
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
