import type { SecurityDecision } from "./types.js";

// Sensitive path patterns that should always be blocked
const SENSITIVE_PATTERNS = [
  /[/\\]\.ssh[/\\]/i,
  /[/\\]\.aws[/\\]/i,
  /[/\\]\.gnupg[/\\]/i,
  /[/\\]\.kube[/\\]/i,
  /[/\\]\.env$/i,
  /[/\\]\.env\./i,
  /id_rsa/i,
  /id_ed25519/i,
  /[/\\]credentials/i,
  /[/\\]\.netrc/i,
  /[/\\]\.npmrc/i,
  /[/\\]\.pypirc/i,
  /[/\\]auth\.json/i,
  /[/\\]secrets?\./i,
  /[/\\]password/i,
  /[/\\]\.git[/\\]config/i,
];

// Dangerous shell commands
const DANGEROUS_COMMANDS = [
  /\brm\s+-rf\s+[/~]/i,
  /\bsudo\b/i,
  /\bchmod\s+777\b/i,
  /\bcurl\b.*\|\s*\bbash\b/i,
  /\bwget\b.*\|\s*\bsh\b/i,
  /\bpowershell\b.*-enc/i,
  /\bnet\s+user\b/i,
  /\breg\s+(add|delete)\b/i,
];

interface ToolCallContext {
  toolName: string;
  args: Record<string, unknown>;
  sessionId: string;
}

/**
 * Security layer that evaluates tool calls before execution.
 * This is a standalone implementation. When AriKernel is integrated,
 * this wraps AriKernel's evaluate() method and adds our defaults.
 */
export class SecurityLayer {
  private workspace: string;
  private auditLog: Array<{ timestamp: number; tool: string; decision: SecurityDecision }> = [];

  constructor(workspace: string) {
    this.workspace = workspace;
  }

  evaluate(ctx: ToolCallContext): SecurityDecision {
    const { toolName, args } = ctx;

    let decision: SecurityDecision;

    switch (toolName) {
      case "read":
      case "write":
      case "edit":
        decision = this.evaluateFileAccess(toolName, String(args.path || ""));
        break;
      case "bash":
        decision = this.evaluateShellCommand(String(args.command || ""));
        break;
      case "web_fetch":
      case "http_request":
        decision = this.evaluateWebFetch(String(args.url || ""));
        break;
      case "browser":
        // Only check SSRF on navigate; other actions operate on the already-loaded page
        if (args.action === "navigate" && args.url) {
          decision = this.evaluateWebFetch(String(args.url));
        } else {
          decision = { allowed: true, reason: "Browser action allowed" };
        }
        break;
      default:
        decision = { allowed: true, reason: "Unknown tool — allowed by default" };
    }

    this.auditLog.push({ timestamp: Date.now(), tool: toolName, decision });
    return decision;
  }

  private evaluateFileAccess(action: string, path: string): SecurityDecision {
    // Block writes/edits to core agent files (but allow dashboard + new files)
    if (action === "write" || action === "edit") {
      const coreProtectedFiles = [
        /[/\\]src[/\\]agent\.ts$/i,
        /[/\\]src[/\\]security\.ts$/i,
        /[/\\]src[/\\]server\.ts$/i,
        /[/\\]src[/\\]auth\.ts$/i,
        /[/\\]src[/\\]codex-client\.ts$/i,
        /[/\\]src[/\\]config\.ts$/i,
        /[/\\]src[/\\]index\.ts$/i,
        /[/\\]src[/\\]types\.ts$/i,
        /[/\\]package\.json$/i,
        /[/\\]tsconfig\.json$/i,
        /[/\\]\.env$/i,
      ];
      for (const pattern of coreProtectedFiles) {
        if (pattern.test(path)) {
          return {
            allowed: false,
            reason: `Blocked: ${path} is a core file. Agent can modify public/, workspace/, and add new src/ files, but not core logic.`,
          };
        }
      }
    }

    // Check sensitive paths
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.test(path)) {
        return {
          allowed: false,
          reason: `Blocked: ${path} matches sensitive path pattern ${pattern.source}`,
        };
      }
    }

    return { allowed: true, reason: "File access allowed" };
  }

  private evaluateShellCommand(command: string): SecurityDecision {
    for (const pattern of DANGEROUS_COMMANDS) {
      if (pattern.test(command)) {
        return {
          allowed: false,
          reason: `Blocked: command matches dangerous pattern ${pattern.source}`,
        };
      }
    }

    return { allowed: true, reason: "Shell command allowed" };
  }

  private evaluateWebFetch(url: string): SecurityDecision {
    try {
      const parsed = new URL(url);
      // Block private network access
      const host = parsed.hostname;
      if (
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "::1" ||
        host.startsWith("192.168.") ||
        host.startsWith("10.") ||
        host.startsWith("172.") ||
        host === "metadata.google.internal" ||
        host === "169.254.169.254"
      ) {
        return {
          allowed: false,
          reason: `Blocked: ${host} is a private/internal address (SSRF protection)`,
        };
      }
    } catch {
      return { allowed: false, reason: `Blocked: invalid URL` };
    }

    return { allowed: true, reason: "Web fetch allowed" };
  }

  getAuditLog() {
    return this.auditLog;
  }
}
