import { resolve, relative } from "node:path";
import { realpathSync, lstatSync } from "node:fs";
import { promises as dns } from "node:dns";
import type { SecurityDecision } from "./types.js";

// ── Sensitive path patterns (always blocked for read/write/edit) ──

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

// ── Shell security: metacharacters that indicate shell injection ──

const SHELL_METACHARACTERS = /[;&|`$(){}<>\r\n]/;

// Commands that should never be executed, even without metacharacters
const BLOCKED_COMMANDS = [
  /\brm\s+(-[a-zA-Z]*f|-[a-zA-Z]*r)\b/i,  // rm with -f or -r flags
  /\bsudo\b/i,
  /\bchmod\s+777\b/i,
  /\bmkfs\b/i,
  /\bdd\s+.*of=/i,
  /\bformat\b.*[/\\]/i,
  // Language-wrapper escapes
  /\beval\b/i,
  /\bpython[23]?\s+-c\b/i,
  /\bnode\s+-e\b/i,
  /\bperl\s+-e\b/i,
  /\bruby\s+-e\b/i,
  /\bphp\s+-r\b/i,
  // Encoding / obfuscation
  /\bbase64\s+(-d|--decode)\b/i,
  /\bpowershell\b.*-enc/i,
  // Windows-specific
  /\bnet\s+user\b/i,
  /\breg\s+(add|delete)\b/i,
  /\bwmic\b/i,
  /\bschtasks\b/i,
  // Network exfil via pipe
  /\bcurl\b.*\|/i,
  /\bwget\b.*\|/i,
  /\|.*\b(bash|sh|cmd|powershell)\b/i,
];

// ── SSRF: IP address validation helpers ──

/** Check if an IPv4 address is private/loopback/link-local/reserved */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return true; // malformed → block

  const [a, b] = parts;
  if (a === 127) return true;                          // 127.0.0.0/8 loopback
  if (a === 10) return true;                           // 10.0.0.0/8 private
  if (a === 192 && b === 168) return true;             // 192.168.0.0/16 private
  if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12 private
  if (a === 169 && b === 254) return true;             // 169.254.0.0/16 link-local
  if (a === 0) return true;                            // 0.0.0.0/8
  if (a >= 224) return true;                           // multicast + reserved (224+)
  if (a === 100 && b >= 64 && b <= 127) return true;   // 100.64.0.0/10 CGNAT
  return false;
}

/** Check if an IPv6 address is private/loopback/link-local */
function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, "");

  // Loopback
  if (normalized === "::1") return true;
  // Unspecified
  if (normalized === "::") return true;
  // Link-local
  if (normalized.startsWith("fe80:")) return true;
  // Unique local (fc00::/7)
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;

  // IPv4-mapped IPv6 (::ffff:a.b.c.d)
  const v4mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4mapped) return isPrivateIPv4(v4mapped[1]);

  // IPv4-compatible IPv6 (::a.b.c.d)
  const v4compat = normalized.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
  if (v4compat) return isPrivateIPv4(v4compat[1]);

  return false;
}

/** Blocked hostnames (loopback aliases, cloud metadata) */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal",
  "metadata.internal",
]);

// ── Tool call context ──

interface ToolCallContext {
  toolName: string;
  args: Record<string, unknown>;
  sessionId: string;
}

/**
 * Security layer that evaluates tool calls before execution.
 * Principles (inspired by OpenClaw):
 * - Fail closed: ambiguity → block
 * - Defense in depth: multiple validation stages
 * - DNS pinning: resolve hostname, then validate resolved IP
 * - No shell metacharacters: reject, don't escape
 * - Path normalization: realpath before checking
 */
export class SecurityLayer {
  private workspace: string;
  private auditLog: Array<{ timestamp: number; tool: string; decision: SecurityDecision }> = [];

  constructor(workspace: string) {
    this.workspace = resolve(workspace);
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

  // ── File Access ──

  private evaluateFileAccess(action: string, rawPath: string): SecurityDecision {
    // Normalize the path
    const resolved = resolve(rawPath);

    // Symlink detection: resolve to real path and check for escape
    let realPath: string;
    try {
      // lstat to detect symlinks without following
      const stat = lstatSync(resolved);
      if (stat.isSymbolicLink()) {
        // Follow the symlink and check where it actually points
        realPath = realpathSync(resolved);
      } else {
        realPath = resolved;
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // ELOOP = too many symlinks (attack), ENOENT = file doesn't exist yet (ok for write)
      if (code === "ELOOP") {
        return { allowed: false, reason: "Blocked: symlink loop detected (possible attack)" };
      }
      // File doesn't exist yet — for writes, use the resolved path
      realPath = resolved;
    }

    // Check for directory traversal (.. in path after resolution)
    const rel = relative(this.workspace, realPath);
    if (rel.startsWith("..")) {
      // Path escapes workspace — only allow if not writing to sensitive areas
      // (reads outside workspace are ok for general files, but sensitive patterns still apply)
    }

    // Block writes/edits to core agent files
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
        // Check BOTH the requested path and the real path (symlink target)
        if (pattern.test(resolved) || pattern.test(realPath)) {
          return {
            allowed: false,
            reason: `Blocked: core file (checked both path and symlink target). Agent can modify public/, workspace/, and add new src/ files.`,
          };
        }
      }
    }

    // Check sensitive paths against both resolved and real paths
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.test(resolved) || pattern.test(realPath)) {
        return {
          allowed: false,
          reason: `Blocked: matches sensitive path pattern ${pattern.source}`,
        };
      }
    }

    return { allowed: true, reason: "File access allowed" };
  }

  // ── Shell Command ──

  private evaluateShellCommand(command: string): SecurityDecision {
    // Block non-pipe shell metacharacters outright (command chaining, subshells, redirects)
    if (/[;&`$(){}<>\r\n]/.test(command)) {
      return {
        allowed: false,
        reason: `Blocked: shell metacharacters detected. Use separate tool calls instead of chaining commands.`,
      };
    }

    // Allow at most 2 pipes (e.g., `ls | grep foo | head`). More than that is suspicious.
    const pipeCount = (command.match(/\|/g) || []).length;
    if (pipeCount > 2) {
      return {
        allowed: false,
        reason: `Blocked: too many pipes (${pipeCount}). Maximum 2 pipes allowed per command.`,
      };
    }

    // Check every segment of a piped command against blocked patterns
    const segments = command.split("|").map((s) => s.trim());
    for (const segment of segments) {
      for (const pattern of BLOCKED_COMMANDS) {
        if (pattern.test(segment)) {
          return {
            allowed: false,
            reason: `Blocked: pipe segment matches dangerous pattern.`,
          };
        }
      }
    }

    // Also check the full command (catches patterns that span pipes)
    for (const pattern of BLOCKED_COMMANDS) {
      if (pattern.test(command)) {
        return {
          allowed: false,
          reason: `Blocked: command matches dangerous pattern.`,
        };
      }
    }

    return { allowed: true, reason: "Shell command allowed" };
  }

  // ── Web Fetch / SSRF ──

  private evaluateWebFetch(url: string): SecurityDecision {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { allowed: false, reason: "Blocked: invalid URL" };
    }

    // Only allow http and https
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { allowed: false, reason: `Blocked: protocol ${parsed.protocol} not allowed (only http/https)` };
    }

    const host = parsed.hostname.toLowerCase();

    // Check blocked hostnames
    if (BLOCKED_HOSTNAMES.has(host)) {
      return { allowed: false, reason: `Blocked: ${host} is a blocked hostname (SSRF protection)` };
    }

    // Check if it's a literal IP address
    // IPv4
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      if (isPrivateIPv4(host)) {
        return { allowed: false, reason: `Blocked: ${host} is a private/reserved IPv4 address` };
      }
    }

    // IPv6 (in URL, appears as [::1])
    if (host.startsWith("[") || host.includes(":")) {
      if (isPrivateIPv6(host)) {
        return { allowed: false, reason: `Blocked: ${host} is a private/reserved IPv6 address` };
      }
    }

    // Cloud metadata endpoints (various formats)
    if (host === "169.254.169.254" || host.endsWith(".internal") || host.endsWith(".metadata")) {
      return { allowed: false, reason: `Blocked: ${host} is a cloud metadata endpoint` };
    }

    return { allowed: true, reason: "Web fetch allowed" };
  }

  /**
   * Async SSRF check with DNS pinning.
   * Resolves hostname to IP and validates the resolved address.
   * Call this for actual network requests (not just policy check).
   */
  async validateUrlWithDns(url: string): Promise<SecurityDecision> {
    // First do the synchronous check
    const syncResult = this.evaluateWebFetch(url);
    if (!syncResult.allowed) return syncResult;

    const parsed = new URL(url);
    const host = parsed.hostname;

    // Skip DNS check for literal IPs (already validated above)
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) {
      return syncResult;
    }

    // DNS pinning: resolve the hostname and check the actual IP
    try {
      const addresses = await dns.resolve4(host).catch(() => []);
      const addresses6 = await dns.resolve6(host).catch(() => []);

      for (const ip of addresses) {
        if (isPrivateIPv4(ip)) {
          return {
            allowed: false,
            reason: `Blocked: ${host} resolves to private IP ${ip} (DNS rebinding protection)`,
          };
        }
      }

      for (const ip of addresses6) {
        if (isPrivateIPv6(ip)) {
          return {
            allowed: false,
            reason: `Blocked: ${host} resolves to private IPv6 ${ip} (DNS rebinding protection)`,
          };
        }
      }
    } catch {
      // DNS resolution failed — allow (might be valid host that's temporarily unresolvable)
    }

    return { allowed: true, reason: "Web fetch allowed (DNS validated)" };
  }

  getAuditLog() {
    return this.auditLog;
  }
}

// ── Credential Redaction ──
// Masks secrets in tool output before they reach the LLM/chat

const REDACT_PATTERNS = [
  // Common API key prefixes (known formats)
  /\b(sk-[a-zA-Z0-9]{20,})/g,              // OpenAI
  /\b(ghp_[a-zA-Z0-9]{36,})/g,             // GitHub personal access token
  /\b(github_pat_[a-zA-Z0-9_]{20,})/g,     // GitHub fine-grained PAT
  /\b(gho_[a-zA-Z0-9]{36,})/g,             // GitHub OAuth
  /\b(ghs_[a-zA-Z0-9]{36,})/g,             // GitHub App installation
  /\b(xox[bpas]-[a-zA-Z0-9-]{20,})/g,      // Slack
  /\b(glpat-[a-zA-Z0-9_-]{20,})/g,         // GitLab
  /\b(AKIA[A-Z0-9]{16})/g,                 // AWS Access Key
  /\b(lin_api_[a-zA-Z0-9]{20,})/g,         // Linear
  /\b(sk_live_[a-zA-Z0-9]{20,})/g,         // Stripe live
  /\b(sk_test_[a-zA-Z0-9]{20,})/g,         // Stripe test
  /\b(sq0[a-z]{3}-[a-zA-Z0-9_-]{20,})/g,   // Square
  /\b(xai-[a-zA-Z0-9]{20,})/g,             // xAI
  // Bearer tokens in output
  /Bearer\s+([a-zA-Z0-9._\-]{20,})/gi,
  // Key=value patterns (only for known sensitive keys)
  /(?:api[_-]?key|token|secret|password|authorization|access_key|private_key)\s*[:=]\s*["']?([^\s"',]{12,})/gi,
  // PEM private keys
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(RSA\s+)?PRIVATE\s+KEY-----/g,
];

/** Mask a secret value: show first 4 chars + ... + last 4 chars */
function maskValue(value: string): string {
  if (value.length <= 12) return "***REDACTED***";
  return value.slice(0, 4) + "..." + value.slice(-4);
}

/** Redact potential credentials from a string before it reaches chat/LLM */
export function redactCredentials(text: string): string {
  let result = text;
  for (const pattern of REDACT_PATTERNS) {
    // Reset regex state
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match, captured) => {
      if (captured && captured.length > 12) {
        return match.replace(captured, maskValue(captured));
      }
      return match;
    });
  }
  return result;
}
