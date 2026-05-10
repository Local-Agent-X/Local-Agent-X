export interface ToolPolicyRule {
  id: string;
  tool: string;          // Glob pattern: "bash", "browser", "http_*", "*"
  action?: string;       // Optional action filter (e.g., "navigate" for browser)
  decision: "allow" | "deny" | "confirm";
  reason: string;
  constraints?: {
    allowedHosts?: string[];     // For http/browser: only these hosts
    blockedHosts?: string[];     // For http/browser: never these hosts
    allowedCommands?: string[];  // For bash: only commands starting with these
    blockedArgs?: string[];      // Reject if any arg contains these strings
    maxCallsPerSession?: number; // Rate limit per session
  };
  /** Match on specific argument values. Keys are arg names, values are glob patterns.
   *  Example: { "command": "git *" } matches bash calls where command starts with "git ".
   *  Example: { "path": "workspace/*" } matches file tools writing to workspace/.
   *  All specified patterns must match for the rule to apply. */
  argMatch?: Record<string, string>;
  priority?: number;     // Higher = evaluated first (default: 0)
}

export interface ToolPolicyConfig {
  defaultDecision: "allow" | "deny";
  rules: ToolPolicyRule[];
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  ruleId?: string;
  confirm?: boolean; // true = allowed but flagged for attention
}
