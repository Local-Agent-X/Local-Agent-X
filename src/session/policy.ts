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
    // ari_* are the AriKernel bridge synonyms — same I/O capability as their
    // canonical counterparts, so they must be denied here too (otherwise a
    // model could call ari_shell/ari_http to slip a block on bash/http_request).
    blockedTools: new Set(["bash", "browser", "http_request", "web_fetch", "ari_shell", "ari_http"]),
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
    // ari_shell (bash), ari_http (network), and ari_file writes are the
    // AriKernel bridge synonyms of the blocked canonical tools. Block the
    // shell/network synonyms outright; ari_file write is gated by the
    // allowFileWrites category check below (it also covers reads, which stay
    // allowed). Without these a model could do shell/IO via the ari_* path.
    blockedTools: new Set(["bash", "write", "edit", "browser", "ari_shell", "ari_http"]),
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
  // ari_http is the AriKernel bridge synonym for http_request — same network
  // capability, so the network category check must cover it too.
  if (!policy.allowNetworkTools && (toolName === "http_request" || toolName === "web_fetch" || toolName === "ari_http")) {
    return `Blocked by session policy (${policy.preset}): network tools disabled`;
  }

  return null; // Allowed
}

export function listPresets(): PolicyPreset[] {
  return Object.keys(PRESETS) as PolicyPreset[];
}
