/**
 * Session-Scoped Security Policies
 *
 * Allows per-session security overrides without changing global config.
 * Users can start a "high security" session (no bash, no browser) or
 * a "dev mode" session (more permissive for coding).
 *
 * Policies are ephemeral — they die with the session. No persistence.
 */

import { hasCapability, type CapabilityClass } from "../tool-registry.js";

export type PolicyPreset = "default" | "high-security" | "dev-mode" | "read-only";

export interface SessionPolicy {
  preset: PolicyPreset;
  /** Capability classes this session refuses, judged per call. */
  blockedClasses: readonly CapabilityClass[];
  allowedTools: Set<string>; // If non-empty, ONLY these tools allowed (whitelist mode)
}

// A preset blocks CAPABILITY CLASSES, each judged for the call in hand
// (hasCapability with its args), so every synonym is covered by its own policy
// row — bash's process_* family, write's edit_lines / multi_edit / bulk_replace
// / delete_file and ari_file, the document tools' write actions, every sender in
// the egress class — and a spreadsheet read is not refused as a write.
const PRESETS: Record<PolicyPreset, readonly CapabilityClass[]> = {
  "default": [],
  "high-security": ["shell", "egress"],
  "dev-mode": [],
  "read-only": ["shell", "egress", "workspace-write"],
};

const CLASS_VERB: Record<CapabilityClass, string> = {
  "shell": "runs commands",
  "egress": "sends data off this computer",
  "workspace-write": "writes files",
  "sensitive-read": "reads sensitive content",
};

// Active policies per session
const sessionPolicies = new Map<string, SessionPolicy>();

export function setSessionPolicy(sessionId: string, preset: PolicyPreset): SessionPolicy {
  const policy: SessionPolicy = { preset, blockedClasses: PRESETS[preset], allowedTools: new Set() };
  sessionPolicies.set(sessionId, policy);
  return policy;
}

export function getSessionPolicy(sessionId: string): SessionPolicy {
  return sessionPolicies.get(sessionId) || { preset: "default", blockedClasses: PRESETS["default"], allowedTools: new Set() };
}

export function clearSessionPolicy(sessionId: string): void {
  sessionPolicies.delete(sessionId);
}

/** Set a tool whitelist on a session (used by skill restrictions). Stores the policy if not already stored. */
export function setSessionAllowedTools(sessionId: string, tools: Set<string>): void {
  let policy = sessionPolicies.get(sessionId);
  if (!policy) {
    policy = { preset: "default", blockedClasses: PRESETS["default"], allowedTools: new Set() };
    sessionPolicies.set(sessionId, policy);
  }
  policy.allowedTools = tools;
}

/** Clear the tool whitelist on a session (restores full tool access). */
export function clearSessionAllowedTools(sessionId: string): void {
  const policy = sessionPolicies.get(sessionId);
  if (policy) policy.allowedTools = new Set();
}

/**
 * Check if a tool call is allowed by session policy.
 * Returns null if allowed, or a reason string if blocked.
 */
export function checkSessionPolicy(sessionId: string, toolName: string, args?: Record<string, unknown>): string | null {
  const policy = getSessionPolicy(sessionId);

  // Whitelist mode: if allowedTools is non-empty, only those are permitted
  if (policy.allowedTools.size > 0 && !policy.allowedTools.has(toolName)) {
    return `Blocked by session policy (${policy.preset}): tool "${toolName}" not in allowed list`;
  }

  const blocked = policy.blockedClasses.find((cls) => hasCapability(toolName, cls, args));
  if (blocked) {
    return `Blocked by session policy (${policy.preset}): this "${toolName}" call ${CLASS_VERB[blocked]}`;
  }

  return null; // Allowed
}

export function listPresets(): PolicyPreset[] {
  return Object.keys(PRESETS) as PolicyPreset[];
}
