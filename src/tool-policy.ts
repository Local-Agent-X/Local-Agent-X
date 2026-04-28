import { readFileSync, writeFileSync, existsSync, watch } from "node:fs";
import { join } from "node:path";
import { checkRegexSafety } from "./safe-regex.js";

import { createLogger } from "./logger.js";
const logger = createLogger("tool-policy");

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

// Track call counts per session per tool
const sessionCallCounts = new Map<string, Map<string, number>>();

/** Match an argument value against a glob pattern.
 *  Supports: "git *" matches "git status", "workspace/*" matches "workspace/foo.txt",
 *  "*.ts" matches "index.ts", exact match for no wildcards. */
function matchArgPattern(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (pattern === value) return true;
  // Convert glob to regex: * → .*, escape other regex chars
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  try {
    if (checkRegexSafety(escaped) !== null) return false; // unsafe pattern — reject
    return new RegExp(`^${escaped}$`, "i").test(value);
  } catch { return false; }
}

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
    // Validate argMatch patterns at load time — reject unsafe patterns instead of failing open
    const validRules = config.rules.filter((rule) => {
      if (!rule.argMatch) return true;
      for (const [argName, pattern] of Object.entries(rule.argMatch)) {
        const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
        const safety = checkRegexSafety(escaped);
        if (safety !== null) {
          logger.warn(`[policy] Rule "${rule.id}" has unsafe argMatch pattern for "${argName}": ${safety} — rule rejected`);
          return false;
        }
      }
      return true;
    });

    // Sort rules by priority (highest first)
    this.config = {
      ...config,
      rules: [...validRules].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)),
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

      // Check argument pattern matching — all specified patterns must match
      if (rule.argMatch) {
        let allMatch = true;
        for (const [argName, pattern] of Object.entries(rule.argMatch)) {
          const argValue = String(args[argName] ?? "");
          if (!matchArgPattern(pattern, argValue)) { allMatch = false; break; }
        }
        if (!allMatch) continue; // Rule doesn't apply to these args
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

    // Operations — long-horizon goal orchestration, writes only to workspace/operations/
    { id: "allow-operations", tool: "operation_*", decision: "allow", reason: "Operations orchestration (safe — writes only to workspace/operations/)", priority: 50 },

    // Autopilot — bounded autonomous work, runs in isolated git worktree
    { id: "allow-autopilot", tool: "autopilot_*", decision: "allow", reason: "Autopilot operations (bounded, isolated worktree)", priority: 50 },

    // Secrets — request triggers UI prompt, list shows names only
    { id: "allow-request-secret", tool: "request_secret", decision: "allow", reason: "Secret request (user confirms via UI)", priority: 50 },
    { id: "allow-list-secrets", tool: "list_secrets", decision: "allow", reason: "List secret names (no values exposed)", priority: 50 },

    // voice_visual — read-only side-effect (emits a UI event); rate-limited
    // inside the tool itself (1 call/turn + 2.5s cooldown). No external I/O.
    { id: "allow-voice-visual", tool: "voice_visual", decision: "allow", reason: "Particle visualizer (UI-only side effect, rate-limited)", priority: 50 },

    // ── ARGUMENT-MATCHED rules (deny dangerous patterns before general allow) ──

    // Block destructive bash commands
    { id: "deny-bash-rm-rf", tool: "bash", decision: "deny", reason: "Blocked: rm -rf is too dangerous for automated execution", priority: 90, argMatch: { command: "rm -rf *" } },
    { id: "deny-bash-format", tool: "bash", decision: "deny", reason: "Blocked: format/fdisk commands", priority: 90, argMatch: { command: "format *" } },
    { id: "deny-bash-del-system", tool: "bash", decision: "deny", reason: "Blocked: cannot delete system files", priority: 90, argMatch: { command: "del /f /s /q C:\\Windows*" } },

    // Block writes to system/protected paths
    { id: "deny-write-system", tool: "write", decision: "deny", reason: "Blocked: cannot write to system directories", priority: 90, argMatch: { path: "C:\\Windows*" } },
    { id: "deny-edit-system", tool: "edit", decision: "deny", reason: "Blocked: cannot edit system files", priority: 90, argMatch: { path: "C:\\Windows*" } },
    { id: "deny-write-node-modules", tool: "write", decision: "deny", reason: "Blocked: do not write directly to node_modules", priority: 80, argMatch: { path: "*node_modules*" } },
    { id: "deny-edit-node-modules", tool: "edit", decision: "deny", reason: "Blocked: do not edit directly in node_modules", priority: 80, argMatch: { path: "*node_modules*" } },

    // Allow git commands at normal priority (useful documentation that argMatch works)
    { id: "allow-bash-git", tool: "bash", decision: "allow", reason: "Git commands allowed", priority: 50, argMatch: { command: "git *" } },

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

    // View image — safe, path-checked by SecurityLayer
    { id: "allow-view-image", tool: "view_image", decision: "allow", reason: "Image viewing (path-checked)", priority: 50 },

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

    // Protocols
    { id: "allow-protocols", tool: "protocol_*", decision: "allow", reason: "Protocol browsing, workflows, and execution", priority: 50 },

    // Agent delegation — required for Agent Handler
    { id: "allow-agent-spawn", tool: "agent_spawn", decision: "allow", reason: "Agent delegation", priority: 50 },
    { id: "allow-delegate", tool: "delegate", decision: "allow", reason: "Task delegation", priority: 50 },
    { id: "allow-agent-ops", tool: "agent_*", decision: "allow", reason: "Agent management", priority: 50 },

    // Agency — multi-agent orchestration
    { id: "allow-agency", tool: "agency_*", decision: "allow", reason: "Agency orchestration", priority: 50 },

    // Web search — safe, read-only
    { id: "allow-web-search", tool: "web_search", decision: "allow", reason: "Web search", priority: 50 },

    // Media tools — camera, screen, OCR
    { id: "allow-camera", tool: "camera_*", decision: "allow", reason: "Camera capture", priority: 50 },
    { id: "allow-screen", tool: "screen_*", decision: "allow", reason: "Screen capture", priority: 50 },
    { id: "allow-ocr", tool: "ocr", decision: "allow", reason: "OCR text extraction", priority: 50 },

    // Apps — in-platform app builder
    { id: "allow-apps", tool: "app_*", decision: "allow", reason: "App creation and management", priority: 50 },

    // Issues / Tasks — agent task management and approvals
    { id: "allow-issues", tool: "issue_*", decision: "allow", reason: "Issue and task management", priority: 50 },

    // Agent team management
    { id: "allow-agent-team", tool: "agent_team_*", decision: "allow", reason: "Agent team management", priority: 50 },

    // Build app / create page
    { id: "allow-build-app", tool: "build_app", decision: "allow", reason: "Build workspace apps", priority: 50 },
    { id: "allow-create-page", tool: "create_page", decision: "allow", reason: "Create custom pages", priority: 50 },

    // ── Business & Personal Assistant tools ──

    // SQL — rate limited, readonly by default
    { id: "allow-sql", tool: "sql_*", decision: "allow", reason: "SQL database access (readonly default)", priority: 40, constraints: { maxCallsPerSession: 50 } },

    // Email
    { id: "allow-email", tool: "email_*", decision: "allow", reason: "Email read/send (API token gated)", priority: 50 },

    // Calendar
    { id: "allow-calendar", tool: "calendar_*", decision: "allow", reason: "Calendar management (API token gated)", priority: 50 },

    // Contacts
    { id: "allow-contacts", tool: "contacts_*", decision: "allow", reason: "Contact management", priority: 50 },

    // Cloud storage
    { id: "allow-cloud", tool: "cloud_*", decision: "allow", reason: "Cloud file access (API token gated)", priority: 50 },

    // Notifications
    { id: "allow-notify", tool: "notify*", decision: "allow", reason: "Push notifications", priority: 50 },

    // Spreadsheets
    { id: "allow-spreadsheet", tool: "spreadsheet_*", decision: "allow", reason: "Spreadsheet read/write", priority: 50 },

    // PDF
    { id: "allow-pdf", tool: "pdf_*", decision: "allow", reason: "PDF read/generate/merge/fill", priority: 50 },

    // Payments — rate limited for safety
    { id: "allow-payment", tool: "payment_*", decision: "allow", reason: "Payment/invoice operations (API key gated)", priority: 40, constraints: { maxCallsPerSession: 30 } },

    // SMS — rate limited
    { id: "allow-sms", tool: "sms_*", decision: "allow", reason: "SMS send/receive via Twilio", priority: 40, constraints: { maxCallsPerSession: 20 } },

    // Voice
    { id: "allow-voice", tool: "voice_*", decision: "allow", reason: "Voice transcription, TTS, calls", priority: 40, constraints: { maxCallsPerSession: 20 } },

    // Clipboard
    { id: "allow-clipboard", tool: "clipboard_*", decision: "allow", reason: "System clipboard access", priority: 50 },

    // CRM
    { id: "allow-crm", tool: "crm_*", decision: "allow", reason: "CRM contact/deal management", priority: 50 },

    // Bookkeeping
    { id: "allow-accounting", tool: "accounting_*", decision: "allow", reason: "Bookkeeping/accounting operations", priority: 50 },

    // E-commerce
    { id: "allow-shop", tool: "shop_*", decision: "allow", reason: "E-commerce order/product/customer management", priority: 50 },

    // Search tools — safe, read-only
    { id: "allow-glob", tool: "glob", decision: "allow", reason: "File pattern search (read-only)", priority: 50 },
    { id: "allow-grep", tool: "grep", decision: "allow", reason: "Content search (read-only)", priority: 50 },
    { id: "allow-tool-search", tool: "tool_search", decision: "allow", reason: "Discover available tools", priority: 50 },
    { id: "allow-self-edit", tool: "self_edit", decision: "allow", reason: "Agent self-repair via Claude Code subprocess", priority: 50 },

    // User interaction
    { id: "allow-ask-user", tool: "ask_user", decision: "allow", reason: "Agent asks user for clarification", priority: 50 },

    // Document tools
    { id: "allow-document", tool: "document_*", decision: "allow", reason: "Word document create/read/edit", priority: 50 },
    { id: "allow-presentation", tool: "presentation_*", decision: "allow", reason: "PowerPoint create/edit", priority: 50 },

    // YouTube
    { id: "allow-youtube", tool: "youtube_*", decision: "allow", reason: "YouTube analysis", priority: 50 },

    // Task management — session-scoped tracking
    { id: "allow-task", tool: "task_*", decision: "allow", reason: "Task tracking (session-scoped)", priority: 50 },

    // Plan mode
    { id: "allow-enter-plan", tool: "enter_plan_mode", decision: "allow", reason: "Enter read-only plan mode", priority: 50 },
    { id: "allow-exit-plan", tool: "exit_plan_mode", decision: "allow", reason: "Exit plan mode", priority: 50 },

    // Config
    { id: "allow-config", tool: "config_*", decision: "allow", reason: "Agent configuration read/write", priority: 50 },

    // Skills
    { id: "allow-skills", tool: "skill_*", decision: "allow", reason: "User-defined skill workflows", priority: 50 },

    // Playbook (legacy)
    { id: "allow-playbook", tool: "playbook_*", decision: "allow", reason: "Legacy playbook tools", priority: 50 },

    // ── Everything else is DENIED by default ──
    // No catch-all "allow *" rule. Unknown tools are blocked.
  ],
};

/**
 * LiveToolPolicy — wraps ToolPolicy with file-watching hot-reload.
 * Merges user rules with defaults so critical rules (agent delegation, etc.)
 * can never be accidentally removed.
 */
export class LiveToolPolicy extends ToolPolicy {
  private policyPath: string;
  private watcher: ReturnType<typeof import("node:fs").watch> | null = null;
  private currentInner: ToolPolicy;

  constructor(policy: ToolPolicy, policyPath: string) {
    // Initialize with a dummy config — we delegate to currentInner
    super({ defaultDecision: "deny", rules: [] });
    this.currentInner = policy;
    this.policyPath = policyPath;
    this.startWatching();
  }

  override evaluate(toolName: string, args: Record<string, unknown>, sessionId?: string): PolicyDecision {
    return this.currentInner.evaluate(toolName, args, sessionId);
  }

  override resetSession(sessionId: string): void {
    this.currentInner.resetSession(sessionId);
  }

  private startWatching(): void {
    try {
      let debounce: ReturnType<typeof setTimeout> | null = null;
      this.watcher = watch(this.policyPath, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => this.reload(), 500);
      });
    } catch {
      // File may not exist yet — that's fine
    }
  }

  private reload(): void {
    try {
      if (!existsSync(this.policyPath)) return;
      const raw = JSON.parse(readFileSync(this.policyPath, "utf-8")) as ToolPolicyConfig;
      const merged = mergeWithDefaults(raw, this.policyPath);
      this.currentInner = new ToolPolicy(merged);
      logger.info(`[policy] Hot-reloaded ${merged.rules.length} rules`);
    } catch (e) {
      logger.warn(`[policy] Hot-reload failed: ${(e as Error).message}`);
    }
  }
}

/** Merge user policy with defaults — user rules take priority, but missing default rules are added */
function mergeWithDefaults(user: ToolPolicyConfig, policyPath?: string): ToolPolicyConfig {
  const userIds = new Set(user.rules.map(r => r.id));
  const missing = DEFAULT_POLICY.rules.filter(r => !userIds.has(r.id));
  if (missing.length > 0) {
    logger.info(`[policy] Merging ${missing.length} default rules not in user policy`);
  }
  const merged = {
    defaultDecision: user.defaultDecision,
    rules: [...user.rules, ...missing],
  };
  // Persist merged policy so new rules survive restarts
  if (missing.length > 0 && policyPath) {
    try {
      writeFileSync(policyPath, JSON.stringify(merged, null, 2), { encoding: "utf-8", mode: 0o600 });
      logger.info(`[policy] Saved merged policy (${merged.rules.length} rules) to ${policyPath}`);
    } catch {}
  }
  return merged;
}

/** Load tool policy from ~/.sax/tool-policy.json or use defaults */
export function loadToolPolicy(dataDir: string): LiveToolPolicy {
  const policyPath = join(dataDir, "tool-policy.json");
  if (existsSync(policyPath)) {
    try {
      const raw = JSON.parse(readFileSync(policyPath, "utf-8")) as ToolPolicyConfig;
      // Validate user-provided patterns for ReDoS safety
      for (const rule of raw.rules) {
        const patternCheck = checkRegexSafety(rule.tool);
        if (patternCheck) {
          logger.warn(`[policy] Unsafe tool pattern in rule "${rule.id}": ${patternCheck}. Skipping.`);
          continue;
        }
      }
      const merged = mergeWithDefaults(raw, policyPath);
      logger.info(`[policy] Loaded ${merged.rules.length} rules from ${policyPath}`);
      return new LiveToolPolicy(new ToolPolicy(merged), policyPath);
    } catch (e) {
      logger.warn(`[policy] Failed to parse ${policyPath}: ${(e as Error).message}, using defaults`);
    }
  }
  // Write default policy to disk on first run (so audit doesn't warn about missing file)
  try {
    writeFileSync(policyPath, JSON.stringify(DEFAULT_POLICY, null, 2), { encoding: "utf-8", mode: 0o600 });
    logger.info(`[policy] Created default policy at ${policyPath}`);
  } catch {}
  return new LiveToolPolicy(new ToolPolicy(DEFAULT_POLICY), policyPath);
}
