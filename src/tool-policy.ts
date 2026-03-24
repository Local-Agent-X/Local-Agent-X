import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { checkRegexSafety } from "./safe-regex.js";

/**
 * Tool Policy System
 *
 * Configurable allow/deny rules per tool with glob pattern support.
 * Policies are loaded from ~/.sax/tool-policy.json or inline config.
 *
 * Each rule specifies:
 * - tool pattern (glob): "bash", "browser.*", "http_*", "*"
 * - decision: "allow", "deny", "confirm" (confirm = log warning but allow)
 * - conditions: optional constraints (allowedHosts, blockedArgs, etc.)
 * - reason: human-readable explanation
 *
 * Rules are evaluated top-to-bottom, first match wins.
 * If no rule matches, the default decision applies.
 */

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
  priority?: number;     // Higher = evaluated first (default: 0)
}

export interface ToolPolicyConfig {
  defaultDecision: "allow" | "deny";
  rules: ToolPolicyRule[];
}

// Track call counts per session per tool
const sessionCallCounts = new Map<string, Map<string, number>>();

/** Match a tool name against a glob pattern */
function matchGlob(pattern: string, name: string): boolean {
  if (pattern === "*") return true;
  if (pattern === name) return true;
  // Simple glob: "http_*" matches "http_request"
  if (pattern.endsWith("*")) {
    return name.startsWith(pattern.slice(0, -1));
  }
  // "browser.*" matches "browser" (the tool is "browser", action is separate)
  if (pattern.includes(".*")) {
    return name === pattern.replace(".*", "");
  }
  return false;
}

/** Match a host against an allowlist (supports *.example.com) */
function matchHost(patterns: string[], host: string): boolean {
  const h = host.toLowerCase();
  return patterns.some((p) => {
    const pl = p.toLowerCase();
    if (pl === h) return true;
    if (pl.startsWith("*.") && h.endsWith(pl.slice(1))) return true;
    return false;
  });
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  ruleId?: string;
  confirm?: boolean; // true = allowed but flagged for attention
}

export class ToolPolicy {
  private config: ToolPolicyConfig;

  constructor(config: ToolPolicyConfig) {
    // Sort rules by priority (highest first)
    this.config = {
      ...config,
      rules: [...config.rules].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)),
    };
  }

  /**
   * Evaluate whether a tool call is allowed.
   * @param toolName - The tool being called
   * @param args - The tool arguments
   * @param sessionId - Current session (for rate limiting)
   */
  evaluate(
    toolName: string,
    args: Record<string, unknown>,
    sessionId: string = "default"
  ): PolicyDecision {
    for (const rule of this.config.rules) {
      if (!matchGlob(rule.tool, toolName)) continue;

      // Check action filter (for tools like "browser" with action param)
      if (rule.action) {
        const toolAction = String(args.action || "");
        if (rule.action !== toolAction && rule.action !== "*") continue;
      }

      // Check constraints
      if (rule.constraints) {
        const c = rule.constraints;

        // Host constraints (for http_request, web_fetch, browser navigate)
        const url = String(args.url || "");
        if (url && (c.allowedHosts || c.blockedHosts)) {
          try {
            const host = new URL(url).hostname;
            if (c.allowedHosts && !matchHost(c.allowedHosts, host)) {
              return {
                allowed: false,
                reason: `Host "${host}" not in allowlist for ${toolName}`,
                ruleId: rule.id,
              };
            }
            if (c.blockedHosts && matchHost(c.blockedHosts, host)) {
              return {
                allowed: false,
                reason: `Host "${host}" is blocked by policy`,
                ruleId: rule.id,
              };
            }
          } catch {
            // Invalid URL — let SSRF checks handle it
          }
        }

        // Command constraints (for bash)
        if (c.allowedCommands && toolName === "bash") {
          const cmd = String(args.command || "").trim();
          const firstWord = cmd.split(/\s/)[0];
          if (!c.allowedCommands.some((ac) => firstWord === ac || cmd.startsWith(ac))) {
            return {
              allowed: false,
              reason: `Command "${firstWord}" not in allowlist`,
              ruleId: rule.id,
            };
          }
        }

        // Blocked args (string contains check)
        if (c.blockedArgs) {
          const argStr = JSON.stringify(args);
          for (const blocked of c.blockedArgs) {
            if (argStr.includes(blocked)) {
              return {
                allowed: false,
                reason: `Arguments contain blocked pattern "${blocked}"`,
                ruleId: rule.id,
              };
            }
          }
        }

        // Per-session rate limit
        if (c.maxCallsPerSession) {
          let sessionMap = sessionCallCounts.get(sessionId);
          if (!sessionMap) {
            sessionMap = new Map();
            sessionCallCounts.set(sessionId, sessionMap);
          }
          const count = (sessionMap.get(toolName) || 0) + 1;
          sessionMap.set(toolName, count);
          if (count > c.maxCallsPerSession) {
            return {
              allowed: false,
              reason: `Tool "${toolName}" exceeded max ${c.maxCallsPerSession} calls per session`,
              ruleId: rule.id,
            };
          }
        }
      }

      // Rule matched — apply decision
      if (rule.decision === "deny") {
        return { allowed: false, reason: rule.reason, ruleId: rule.id };
      }
      if (rule.decision === "confirm") {
        return { allowed: true, reason: rule.reason, ruleId: rule.id, confirm: true };
      }
      return { allowed: true, reason: rule.reason, ruleId: rule.id };
    }

    // No rule matched — use default
    return {
      allowed: this.config.defaultDecision === "allow",
      reason: this.config.defaultDecision === "allow"
        ? "Allowed by default policy"
        : "Denied by default policy (no matching rule)",
    };
  }

  /** Reset per-session call counts (call when session ends) */
  resetSession(sessionId: string): void {
    sessionCallCounts.delete(sessionId);
  }
}

// ── Default policy ──

const DEFAULT_POLICY: ToolPolicyConfig = {
  // DEFAULT-DENY: everything is blocked unless explicitly allowed.
  // This is the enterprise-safe posture. Users can override via ~/.sax/tool-policy.json.
  defaultDecision: "deny",
  rules: [
    // ── Explicitly ALLOWED tools (safe by design) ──

    // File operations — safe, gated by SecurityLayer path checks
    { id: "allow-read", tool: "read", decision: "allow", reason: "File read (path-checked by SecurityLayer)", priority: 50 },
    { id: "allow-write", tool: "write", decision: "allow", reason: "File write (path-checked by SecurityLayer)", priority: 50 },
    { id: "allow-edit", tool: "edit", decision: "allow", reason: "File edit (path-checked by SecurityLayer)", priority: 50 },

    // Memory tools — safe, internal only
    { id: "allow-memory", tool: "memory_*", decision: "allow", reason: "Memory operations (internal)", priority: 50 },

    // Secrets — request triggers UI prompt, list shows names only
    { id: "allow-request-secret", tool: "request_secret", decision: "allow", reason: "Secret request (user confirms via UI)", priority: 50 },
    { id: "allow-list-secrets", tool: "list_secrets", decision: "allow", reason: "List secret names (no values exposed)", priority: 50 },

    // ── ALLOWED but RATE-LIMITED tools (can be abused) ──

    // Shell — rate limited, gated by SecurityLayer command checks
    {
      id: "allow-bash-limited",
      tool: "bash",
      decision: "allow",
      reason: "Shell allowed (rate limited, command-checked)",
      priority: 40,
      constraints: { maxCallsPerSession: 30 },
    },

    // HTTP — rate limited, gated by SSRF + DNS pinning
    {
      id: "allow-http-limited",
      tool: "http_request",
      decision: "allow",
      reason: "HTTP allowed (rate limited, SSRF-checked, content-wrapped)",
      priority: 40,
      constraints: { maxCallsPerSession: 60 },
    },

    // Web fetch — rate limited, simpler than http_request
    {
      id: "allow-webfetch-limited",
      tool: "web_fetch",
      decision: "allow",
      reason: "Web fetch allowed (rate limited, SSRF-checked, content-wrapped)",
      priority: 40,
      constraints: { maxCallsPerSession: 60 },
    },

    // Browser — rate limited, all actions except evaluate
    {
      id: "allow-browser",
      tool: "browser",
      decision: "allow",
      reason: "Browser allowed (rate limited)",
      priority: 40,
      constraints: { maxCallsPerSession: 100 },
    },

    // Image generation — rate limited
    {
      id: "allow-generate-image",
      tool: "generate_image",
      decision: "allow",
      reason: "Image generation allowed (rate limited)",
      priority: 40,
      constraints: { maxCallsPerSession: 20 },
    },

    // Video generation — rate limited (slow + GPU intensive)
    {
      id: "allow-generate-video",
      tool: "generate_video",
      decision: "allow",
      reason: "Video generation allowed (rate limited)",
      priority: 40,
      constraints: { maxCallsPerSession: 5 },
    },

    // ── FLAGGED tools (allowed but logged as elevated risk) ──

    {
      id: "flag-browser-evaluate",
      tool: "browser",
      action: "evaluate",
      decision: "confirm",
      reason: "Browser JS evaluation — flagged for review",
      priority: 100,
    },

    // ── Everything else is DENIED by default ──
    // No catch-all "allow *" rule. Unknown tools are blocked.
  ],
};

/** Load tool policy from ~/.sax/tool-policy.json or use defaults */
export function loadToolPolicy(dataDir: string): ToolPolicy {
  const policyPath = join(dataDir, "tool-policy.json");
  if (existsSync(policyPath)) {
    try {
      const raw = JSON.parse(readFileSync(policyPath, "utf-8")) as ToolPolicyConfig;
      // Validate user-provided patterns for ReDoS safety
      for (const rule of raw.rules) {
        const patternCheck = checkRegexSafety(rule.tool);
        if (patternCheck) {
          console.warn(`[policy] Unsafe tool pattern in rule "${rule.id}": ${patternCheck}. Skipping.`);
          continue;
        }
      }
      console.log(`[policy] Loaded ${raw.rules.length} rules from ${policyPath}`);
      return new ToolPolicy(raw);
    } catch (e) {
      console.warn(`[policy] Failed to parse ${policyPath}: ${(e as Error).message}, using defaults`);
    }
  }
  return new ToolPolicy(DEFAULT_POLICY);
}
