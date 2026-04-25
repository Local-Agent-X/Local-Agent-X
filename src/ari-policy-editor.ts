/**
 * ARI Policy Editor — CRUD for custom security rules
 *
 * Policies are stored in ~/.sax/custom-policies.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export interface PolicyRule {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** Tool name this rule applies to, or "*" for all */
  tool: string;
  /** "block" | "allow" | "warn" */
  action: "block" | "allow" | "warn";
  /** Condition: regex pattern to match against tool args (stringified) */
  pattern?: string;
  /** Priority: higher = evaluated first */
  priority: number;
  /** Optional: restrict to specific roles */
  roles?: string[];
}

interface PolicyStore {
  version: number;
  rules: PolicyRule[];
}

const POLICIES_FILE = join(homedir(), ".lax", "custom-policies.json");

function ensureDir(): void {
  const dir = join(homedir(), ".lax");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function loadStore(): PolicyStore {
  if (!existsSync(POLICIES_FILE)) {
    return { version: 1, rules: [] };
  }
  try {
    return JSON.parse(readFileSync(POLICIES_FILE, "utf-8"));
  } catch {
    return { version: 1, rules: [] };
  }
}

function saveStore(store: PolicyStore): void {
  ensureDir();
  writeFileSync(POLICIES_FILE, JSON.stringify(store, null, 2), "utf-8");
}

/** List all custom policy rules */
export function listPolicies(): PolicyRule[] {
  return loadStore().rules;
}

/** Get a policy by ID */
export function getPolicy(id: string): PolicyRule | null {
  const store = loadStore();
  return store.rules.find(r => r.id === id) || null;
}

/** Create a new policy rule */
export function createPolicy(input: Omit<PolicyRule, "id" | "createdAt" | "updatedAt">): PolicyRule {
  const store = loadStore();
  const now = new Date().toISOString();
  const rule: PolicyRule = {
    ...input,
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
  };
  store.rules.push(rule);
  saveStore(store);
  return rule;
}

/** Update an existing policy rule */
export function updatePolicy(id: string, updates: Partial<Omit<PolicyRule, "id" | "createdAt">>): PolicyRule | null {
  const store = loadStore();
  const idx = store.rules.findIndex(r => r.id === id);
  if (idx === -1) return null;
  store.rules[idx] = {
    ...store.rules[idx],
    ...updates,
    id: store.rules[idx].id,
    createdAt: store.rules[idx].createdAt,
    updatedAt: new Date().toISOString(),
  };
  saveStore(store);
  return store.rules[idx];
}

/** Delete a policy rule */
export function deletePolicy(id: string): boolean {
  const store = loadStore();
  const before = store.rules.length;
  store.rules = store.rules.filter(r => r.id !== id);
  if (store.rules.length === before) return false;
  saveStore(store);
  return true;
}

/** Toggle a policy rule enabled/disabled */
export function togglePolicy(id: string): PolicyRule | null {
  const store = loadStore();
  const rule = store.rules.find(r => r.id === id);
  if (!rule) return null;
  rule.enabled = !rule.enabled;
  rule.updatedAt = new Date().toISOString();
  saveStore(store);
  return rule;
}

/** Evaluate a tool call against custom policies. Returns first matching rule or null. */
export function evaluateCustomPolicies(
  toolName: string,
  args: Record<string, unknown>,
  role?: string
): { rule: PolicyRule; action: "block" | "allow" | "warn" } | null {
  const store = loadStore();
  const activeRules = store.rules
    .filter(r => r.enabled)
    .sort((a, b) => b.priority - a.priority);

  const argsStr = JSON.stringify(args);

  for (const rule of activeRules) {
    // Tool match
    if (rule.tool !== "*" && rule.tool !== toolName) continue;
    // Role match
    if (rule.roles && rule.roles.length > 0 && role && !rule.roles.includes(role)) continue;
    // Pattern match
    if (rule.pattern) {
      try {
        // Guard against ReDoS: reject overly complex patterns
        if (rule.pattern.length > 200) continue;
        if (/(\.\*){3,}|(\([^)]*\+\)[^)]*){2,}|(\([^)]*\)\{[^}]+\}\s*){3,}/.test(rule.pattern)) continue;
        if (!new RegExp(rule.pattern, "i").test(argsStr)) continue;
      } catch {
        continue; // Invalid regex — skip
      }
    }
    return { rule, action: rule.action };
  }
  return null;
}

/** Import policies from JSON array */
export function importPolicies(rules: Omit<PolicyRule, "id" | "createdAt" | "updatedAt">[]): number {
  let count = 0;
  for (const rule of rules) {
    createPolicy(rule);
    count++;
  }
  return count;
}

/** Export all policies as JSON */
export function exportPolicies(): string {
  return JSON.stringify(loadStore(), null, 2);
}
