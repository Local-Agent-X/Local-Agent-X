/**
 * Session-Scoped Security Policies
 *
 * Allows per-session security overrides without changing global config.
 * Users can start a "high security" session (no bash, no browser) or
 * a "dev mode" session (more permissive for coding).
 *
 * Policies are ephemeral — they die with the session. No persistence.
 */

export type PolicyPreset = "default" | "high-security" | "dev-mode" | "read-only";

export interface SessionPolicy {
  preset: PolicyPreset;
  blockedTools: Set<string>;
  allowedTools: Set<string>; // If non-empty, ONLY these tools allowed (whitelist mode)
  maxBashTimeout: number;    // ms
  allowFileWrites: boolean;
  allowBrowser: boolean;
  allowNetworkTools: boolean;
}

const PRESETS: Record<PolicyPreset, Omit<SessionPolicy, "preset">> = {
  "default": {
    blockedTools: new Set(),
    allowedTools: new Set(), // empty = all allowed
    maxBashTimeout: 120_000,
    allowFileWrites: true,
    allowBrowser: true,
    allowNetworkTools: true,
  },
  "high-security": {
    blockedTools: new Set(["bash", "browser", "http_request", "web_fetch"]),
    allowedTools: new Set(),
    maxBashTimeout: 0,
    allowFileWrites: true,
    allowBrowser: false,
    allowNetworkTools: false,
  },
  "dev-mode": {
    blockedTools: new Set(),
    allowedTools: new Set(),
    maxBashTimeout: 300_000, // 5 min for builds
    allowFileWrites: true,
    allowBrowser: true,
    allowNetworkTools: true,
  },
  "read-only": {
    blockedTools: new Set(["bash", "write", "edit", "browser"]),
    allowedTools: new Set(),
    maxBashTimeout: 0,
    allowFileWrites: false,
    allowBrowser: false,
    allowNetworkTools: false,
  },
};

// Active policies per session
const sessionPolicies = new Map<string, SessionPolicy>();

export function setSessionPolicy(sessionId: string, preset: PolicyPreset): SessionPolicy {
  const policy: SessionPolicy = { preset, ...PRESETS[preset] };
  // Copy sets so mutations don't affect presets
  policy.blockedTools = new Set(PRESETS[preset].blockedTools);
  policy.allowedTools = new Set(PRESETS[preset].allowedTools);
  sessionPolicies.set(sessionId, policy);
  return policy;
}

export function getSessionPolicy(sessionId: string): SessionPolicy {
  return sessionPolicies.get(sessionId) || { preset: "default", ...PRESETS["default"], blockedTools: new Set(), allowedTools: new Set() };
}

export function clearSessionPolicy(sessionId: string): void {
  sessionPolicies.delete(sessionId);
}

/** Set a tool whitelist on a session (used by skill restrictions). Stores the policy if not already stored. */
export function setSessionAllowedTools(sessionId: string, tools: Set<string>): void {
  let policy = sessionPolicies.get(sessionId);
  if (!policy) {
    policy = { preset: "default", ...PRESETS["default"], blockedTools: new Set(), allowedTools: new Set() };
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
export function checkSessionPolicy(sessionId: string, toolName: string): string | null {
  const policy = getSessionPolicy(sessionId);

  // Whitelist mode: if allowedTools is non-empty, only those are permitted
  if (policy.allowedTools.size > 0 && !policy.allowedTools.has(toolName)) {
    return `Blocked by session policy (${policy.preset}): tool "${toolName}" not in allowed list`;
  }

  // Blocklist mode
  if (policy.blockedTools.has(toolName)) {
    return `Blocked by session policy (${policy.preset}): tool "${toolName}" is restricted`;
  }

  // Category checks
  if (!policy.allowFileWrites && (toolName === "write" || toolName === "edit")) {
    return `Blocked by session policy (${policy.preset}): file writes disabled`;
  }
  if (!policy.allowBrowser && toolName === "browser") {
    return `Blocked by session policy (${policy.preset}): browser disabled`;
  }
  if (!policy.allowNetworkTools && (toolName === "http_request" || toolName === "web_fetch")) {
    return `Blocked by session policy (${policy.preset}): network tools disabled`;
  }

  return null; // Allowed
}

export function listPresets(): PolicyPreset[] {
  return Object.keys(PRESETS) as PolicyPreset[];
}
