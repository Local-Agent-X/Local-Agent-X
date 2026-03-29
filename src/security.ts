import { resolve, relative, join } from "node:path";
import { realpathSync, lstatSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { promises as dns } from "node:dns";
import { homedir } from "node:os";
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
  /\breg\s+(add|delete|query|export|import|save|restore|load|unload)\b/i,
  /\bwmic\b/i,
  /\bschtasks\b/i,
  // Network exfil via pipe
  /\bcurl\b.*\|/i,
  /\bwget\b.*\|/i,
  /\|.*\b(bash|sh|cmd|powershell)\b/i,
  // ── Shell-as-exfiltration: block network clients entirely ──
  // These can send data to arbitrary hosts, bypassing all HTTP/SSRF controls.
  // The agent should use http_request (which has SSRF checks, DNS pinning,
  // content wrapping, and audit logging) instead of raw shell network tools.
  /\bcurl\s/i,                              // curl (any use)
  /\bwget\s/i,                              // wget (any use)
  /\bnc\s/i,                                // netcat
  /\bncat\s/i,                              // nmap netcat
  /\bsocat\s/i,                             // socat
  /\btelnet\s/i,                            // telnet
  /\bssh\s/i,                               // ssh (outbound)
  /\bscp\s/i,                               // scp
  /\bsftp\s/i,                              // sftp
  /\brsync\s/i,                             // rsync
  /\bftp\s/i,                               // ftp
  /Invoke-WebRequest\b/i,                   // PowerShell web
  /Invoke-RestMethod\b/i,                   // PowerShell REST
  /\bIwr\b/i,                               // PowerShell alias
  /\bIrm\b/i,                               // PowerShell alias
  /\bStart-BitsTransfer\b/i,               // PowerShell BITS
  /\bNet\.WebClient\b/i,                    // .NET web client
  /\bSystem\.Net\.Http/i,                   // .NET HTTP
  /\brequests\.(get|post|put|delete)\b/i,   // Python requests
  /\burllib\.(request|urlopen)\b/i,         // Python urllib
  /\bhttpx?\./i,                            // Python httpx
  /\baiohttp\b/i,                           // Python aiohttp
  // ── Shell escape / injection edge cases ──
  /^\.\s+\//,                               // dot-sourcing: ". /path" (source command)
  /\bsource\s+\//i,                         // source /path
  /[<>]&\d/,                                // fd redirection: <&3, >&3
  /\d+>&\d/,                                // fd duplication: 2>&1 in exotic forms
  /\\\n/,                                   // backslash-newline continuation (multi-line escape)
  // ── Interactive shell / reverse shell escapes ──
  /\bbash\s+-i\b/i,                         // interactive bash
  /\bsh\s+-i\b/i,                           // interactive sh
  /\bzsh\s+-i\b/i,                          // interactive zsh
  /\bpython[23]?\s+-i\b/i,                  // interactive Python
  /\bnode\s+--inspect/i,                     // Node debugger (can execute arbitrary code)
  /\b\/dev\/tcp\//i,                         // bash /dev/tcp reverse shell
  /\bmkfifo\b/i,                             // named pipe (reverse shell building block)
  /\bexec\s+\d+<>/i,                        // fd exec redirect (reverse shell)
  /\bnohup\b.*&$/i,                          // background persistent process
  /\bscreen\s+-[dD]/i,                       // detached screen session
  /\btmux\s+new/i,                           // tmux session (persistence)
  /\bxterm\b.*-e/i,                          // xterm reverse shell
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

export type CallContext = "local" | "api" | "delegated" | "cron";

interface ToolCallContext {
  toolName: string;
  args: Record<string, unknown>;
  sessionId: string;
  callContext?: CallContext; // Where the call originates from
}

// Tools blocked in non-local contexts (API calls, delegated agents, cron jobs)
const CONTEXT_RESTRICTED_TOOLS: Record<string, CallContext[]> = {
  bash: ["delegated", "cron"],           // Shell too dangerous for delegated/automated
  write: ["delegated"],                   // No file writes from delegated agents
  edit: ["delegated"],                    // No file edits from delegated agents
  browser: ["cron"],                      // No browser in automated jobs
  generate_image: ["delegated", "cron"],  // Resource-intensive, block in automation
};

/**
 * Security layer that evaluates tool calls before execution.
 * Principles (inspired by upstream):
 * - Fail closed: ambiguity → block
 * - Defense in depth: multiple validation stages
 * - DNS pinning: resolve hostname, then validate resolved IP
 * - No shell metacharacters: reject, don't escape
 * - Path normalization: realpath before checking
 */
export type FileAccessMode = "workspace" | "common" | "unrestricted";

export class SecurityLayer {
  private workspace: string;
  private auditLog: Array<{ timestamp: number; tool: string; decision: SecurityDecision }> = [];
  private egressAllowlist: Set<string> = new Set();
  fileAccessMode: FileAccessMode = "common";

  constructor(workspace: string, fileAccessMode?: FileAccessMode) {
    this.workspace = resolve(workspace);
    this.fileAccessMode = fileAccessMode || this.loadFileAccessMode();
    // Load egress allowlist from ~/.sax/egress-allowlist.json
    try {
      const allowlistPath = join(homedir(), ".sax", "egress-allowlist.json");
      if (existsSync(allowlistPath)) {
        const domains: string[] = JSON.parse(readFileSync(allowlistPath, "utf-8"));
        this.egressAllowlist = new Set(domains.map((d: string) => d.toLowerCase()));
        console.log(`[security] Egress allowlist loaded: ${this.egressAllowlist.size} domains`);
      }
      // If no file exists, allowlist is empty = all public domains allowed (backwards compatible)
    } catch (e) {
      console.warn(`[security] Failed to load egress allowlist: ${(e as Error).message}`);
    }
    console.log(`[security] File access mode: ${this.fileAccessMode}`);
  }

  private loadFileAccessMode(): FileAccessMode {
    try {
      const cfgPath = join(homedir(), ".sax", "security.json");
      if (existsSync(cfgPath)) {
        const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
        if (["workspace", "common", "unrestricted"].includes(cfg.fileAccessMode)) {
          return cfg.fileAccessMode;
        }
      }
    } catch {}
    return "common"; // Default
  }

  setFileAccessMode(mode: FileAccessMode): void {
    this.fileAccessMode = mode;
    try {
      const cfgPath = join(homedir(), ".sax", "security.json");
      let cfg: Record<string, unknown> = {};
      if (existsSync(cfgPath)) cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      cfg.fileAccessMode = mode;
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf-8");
    } catch {}
    console.log(`[security] File access mode changed to: ${mode}`);
  }

  evaluate(ctx: ToolCallContext): SecurityDecision {
    const { toolName, args } = ctx;

    // Context-based tool tiering: block tools in restricted contexts
    const callCtx = ctx.callContext || "local";
    const restricted = CONTEXT_RESTRICTED_TOOLS[toolName];
    if (restricted && restricted.includes(callCtx)) {
      return {
        allowed: false,
        reason: `Blocked: tool "${toolName}" is not allowed in ${callCtx} context`,
      };
    }

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
        if ((args.action === "navigate" || args.action === "new_tab") && args.url) {
          const browserUrl = String(args.url);
          // Allow localhost/127.0.0.1 for browser — user's own dev servers
          try {
            const host = new URL(browserUrl).hostname;
            if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") {
              decision = { allowed: true, reason: "Browser navigation to localhost allowed" };
            } else {
              decision = this.evaluateWebFetch(browserUrl);
            }
          } catch {
            decision = { allowed: false, reason: "Blocked: invalid URL" };
          }
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
    if (rawPath.includes("\x00")) {
      return { allowed: false, reason: "Blocked: null byte in file path" };
    }

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
      const homeDir = resolve(process.env.HOME || process.env.USERPROFILE || "");

      // Unrestricted mode: allow reads/writes anywhere (except core protected files)
      if (this.fileAccessMode === "unrestricted") {
        // Writes outside workspace still blocked for safety in non-workspace dirs
        if (action === "write" || action === "edit") {
          const projectRoot = resolve(this.workspace, "..");
          const inProject = !relative(projectRoot, realPath).startsWith("..");
          const inHome = !relative(homeDir, realPath).startsWith("..");
          if (!inProject && !inHome) {
            return { allowed: false, reason: "Blocked: cannot write outside home directory even in unrestricted mode" };
          }
        }
        // Reads: allowed everywhere
      } else {
        // Workspace + Common modes: block writes outside workspace
        if (action === "write" || action === "edit") {
          return { allowed: false, reason: "Blocked: cannot write files outside workspace directory" };
        }

        // Reads: check based on mode
        const projectRoot = resolve(this.workspace, "..");
        const saxDir = resolve(homeDir, ".sax");
        const inProject = !relative(projectRoot, realPath).startsWith("..");
        const inSax = !relative(saxDir, realPath).startsWith("..");

        if (this.fileAccessMode === "workspace") {
          // Strict: only project + .sax
          if (!inProject && !inSax) {
            return { allowed: false, reason: "Blocked: workspace mode — reads restricted to project directory only. Change to 'common' mode in Settings to access Downloads, Documents, etc." };
          }
        } else {
          // Common (default): project + .sax + user directories
          const userDirs = ["Downloads", "Documents", "Desktop", "Pictures", "Videos", "Music"].map(
            (d) => resolve(homeDir, d)
          );
          const inUserDir = userDirs.some((d) => !relative(d, realPath).startsWith(".."));
          if (!inProject && !inSax && !inUserDir) {
            return { allowed: false, reason: "Blocked: cannot read files outside project and user directories. Change to 'unrestricted' mode in Settings for full access." };
          }
        }
      }
    }

    // Block writes/edits to core agent files — CODE ENFORCED, not just documented
    // Even if the AI is prompt-injected, it CANNOT weaken its own security
    if (action === "write" || action === "edit") {
      const coreProtectedFiles = [
        /[/\\]src[/\\]security\.ts$/i,        // Security layer — guardrails
        /[/\\]src[/\\]auth\.ts$/i,            // Auth — token handling
        /[/\\]src[/\\]codex-client\.ts$/i,    // API client — token transport
        /[/\\]src[/\\]codex-ws\.ts$/i,        // WebSocket client
        /[/\\]src[/\\]keychain\.ts$/i,        // Encryption key management
        /[/\\]src[/\\]sanitize\.ts$/i,        // Prompt injection defense
        /[/\\]src[/\\]threat-engine\.ts$/i,   // Threat detection / canary tokens
        /[/\\]src[/\\]rbac\.ts$/i,            // Role-based access control
        /[/\\]src[/\\]safe-regex\.ts$/i,      // Regex safety
        /[/\\]src[/\\]tool-policy\.ts$/i,     // Tool policy enforcement
        /[/\\]\.env$/i,                        // Environment secrets
        /[/\\]\.sax[/\\]secrets\./i,           // Encrypted secrets store
        /[/\\]\.sax[/\\]master\./i,            // Master encryption key
        /[/\\]\.sax[/\\]auth\.json$/i,         // OAuth tokens
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
    const normalizedResolved = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    const normalizedRealPath = process.platform === "win32" ? realPath.toLowerCase() : realPath;
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.test(normalizedResolved) || pattern.test(normalizedRealPath)) {
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
    // Obfuscation detection (inspired by upstream exec-obfuscation-detect)
    try {
      const obfuscationResult = this.detectObfuscation(command);
      if (obfuscationResult) {
        return { allowed: false, reason: obfuscationResult };
      }
    } catch {
      // Don't crash on obfuscation check failure — allow the command through
    }

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
      const cleanHost = host.replace(/^\[/, "").replace(/\]$/, "");
      if (host.startsWith("[") && !host.includes("]")) {
        return { allowed: false, reason: `Blocked: malformed IPv6 address brackets in ${host}` };
      }
      if (isPrivateIPv6(cleanHost)) {
        return { allowed: false, reason: `Blocked: ${host} is a private/reserved IPv6 address` };
      }
    }

    // Cloud metadata endpoints (various formats)
    if (host === "169.254.169.254" || host.endsWith(".internal") || host.endsWith(".metadata")) {
      return { allowed: false, reason: `Blocked: ${host} is a cloud metadata endpoint` };
    }

    // ── Egress domain allowlist ──
    // If an allowlist is configured, only approved domains can be accessed.
    // This prevents exfiltration to attacker-controlled servers.
    if (this.egressAllowlist.size > 0) {
      const allowed = this.egressAllowlist.has(host) ||
        // Check wildcard subdomains: *.example.com matches sub.example.com
        Array.from(this.egressAllowlist).some(d => d.startsWith("*.") && (host === d.slice(2) || host.endsWith("." + d.slice(2))));
      if (!allowed) {
        return { allowed: false, reason: `Blocked: ${host} is not in the egress allowlist. Add it to ~/.sax/egress-allowlist.json to permit.` };
      }
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

  // ── Obfuscation Detection ──

  private detectObfuscation(command: string): string | null {
    // Hex-encoded sequences (e.g., \x72\x6d = "rm")
    if (/\\x[0-9a-f]{2}/i.test(command)) {
      return "Blocked: hex-encoded characters detected (possible obfuscation)";
    }
    // Octal-encoded sequences (e.g., \162\155 = "rm")
    if (/\\[0-3][0-7]{2}/.test(command)) {
      return "Blocked: octal-encoded characters detected (possible obfuscation)";
    }
    // Unicode escape sequences (e.g., \u0072\u006d = "rm")
    if (/\\u[0-9a-f]{4}/i.test(command)) {
      return "Blocked: unicode escape sequences detected (possible obfuscation)";
    }
    // Base64 inline decoding (echo BASE64 | base64 -d)
    if (/base64\s+(-d|--decode)/i.test(command)) {
      return "Blocked: base64 decode in command (possible obfuscation)";
    }
    // printf with escape sequences (printf '\x72\x6d')
    if (/\bprintf\b.*\\(x|u|[0-7])/i.test(command)) {
      return "Blocked: printf with escape sequences (possible obfuscation)";
    }
    // xxd / od reverse (decode hex to binary)
    if (/\bxxd\s+-r\b/i.test(command) || /\bod\b.*-A\s*x/i.test(command)) {
      return "Blocked: hex decode tool (possible obfuscation)";
    }
    // String concatenation tricks: a='r'; b='m'; $a$b
    // We already block $ metacharacter, but check for quoted var assignment patterns
    if (/\b[a-z]=['"][a-z]{1,3}['"]/i.test(command) && command.split("=").length > 3) {
      return "Blocked: suspicious variable assignment pattern (possible string concatenation obfuscation)";
    }
    // rev (reverse string to hide commands)
    if (/\brev\b/i.test(command)) {
      return "Blocked: 'rev' command (commonly used for obfuscation)";
    }
    // ANSI-C quoting with hex escapes (e.g., $'\x72\x6d')
    if (/\$'[^']*\\x[0-9a-fA-F]{2}/.test(command)) {
      return "Blocked: ANSI-C quoting with hex escapes detected";
    }
    // ANSI-C quoting with octal escapes (e.g., $'\162\155')
    if (/\$'[^']*\\[0-7]{3}/.test(command)) {
      return "Blocked: ANSI-C quoting with octal escapes detected";
    }
    // Very long commands are suspicious (likely encoded payloads)
    if (command.length > 2000) {
      return "Blocked: command exceeds 2000 characters (possible encoded payload)";
    }

    return null;
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
    const p = new RegExp(pattern.source, pattern.flags);
    result = result.replace(p, (match, captured) => {
      if (captured && captured.length > 12) {
        return match.replace(captured, maskValue(captured));
      }
      return match;
    });
  }
  return result;
}
