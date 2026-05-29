import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createLogger } from "./logger.js";
import { checkRegexSafety } from "./safe-regex.js";
import { DEFAULT_POLICY } from "./tool-policy/default-rules.js";
import { matchArgPattern, matchGlob, matchHost } from "./tool-policy/matchers.js";
import type { PolicyDecision, ToolPolicyConfig, ToolPolicyRule } from "./tool-policy/types.js";
import { USER_HINTS } from "./types.js";

const logger = createLogger("tool-policy");

export type { PolicyDecision, ToolPolicyConfig, ToolPolicyRule } from "./tool-policy/types.js";

/**
 * Tool Policy System
 *
 * Configurable allow/deny rules per tool with glob pattern support.
 * Policies are loaded from ~/.lax/tool-policy.json or inline config.
 *
 * Each rule specifies:
 * - tool pattern (glob): "bash", "browser.*", "http_*", "*"
 * - decision: "allow", "deny", "confirm" (confirm = log warning but allow)
 * - conditions: optional constraints (allowedHosts, blockedArgs, etc.)
 * - reason: human-readable explanation
 *
 * Rules are evaluated top-to-bottom (after sort by priority desc), first match wins.
 * If no rule matches, the default decision applies.
 */

// Track call counts per session per tool
const sessionCallCounts = new Map<string, Map<string, number>>();

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
   * Find the first rule whose `tool` pattern matches `toolName`, ignoring
   * argMatch/action/constraint filters. Used by the boot-time coverage
   * audit — "is this tool name reachable by any rule, regardless of args?"
   * Returns the rule id, or null if no rule's pattern covers the name.
   *
   * Different from `evaluate()`: evaluate runs full argument checks,
   * constraints, and rate limits, and falls through to defaultDecision
   * if no rule matches. This just answers the structural question
   * "does the policy mention this tool at all?"
   */
  findCoveringRule(toolName: string): string | null {
    for (const rule of this.config.rules) {
      if (matchGlob(rule.tool, toolName)) return rule.id;
    }
    return null;
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
    sessionId: string = "default",
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
        const constraintFailure = this.checkConstraints(rule, toolName, args, sessionId);
        if (constraintFailure) return constraintFailure;
      }

      // Rule matched — apply decision
      if (rule.decision === "deny") {
        return { allowed: false, reason: rule.reason, ruleId: rule.id, userHint: USER_HINTS.policy };
      }
      if (rule.decision === "confirm") {
        return { allowed: true, reason: rule.reason, ruleId: rule.id, confirm: true };
      }
      return { allowed: true, reason: rule.reason, ruleId: rule.id };
    }

    // No rule matched — use default
    const allowed = this.config.defaultDecision === "allow";
    return {
      allowed,
      reason: allowed
        ? "Allowed by default policy"
        : "Denied by default policy (no matching rule)",
      ...(allowed ? {} : { userHint: USER_HINTS.policy }),
    };
  }

  private checkConstraints(
    rule: ToolPolicyRule,
    toolName: string,
    args: Record<string, unknown>,
    sessionId: string,
  ): PolicyDecision | null {
    const c = rule.constraints!;

    // Host constraints (for http_request, web_fetch, browser navigate)
    const url = String(args.url || "");
    if (url && (c.allowedHosts || c.blockedHosts)) {
      try {
        const host = new URL(url).hostname;
        if (c.allowedHosts && !matchHost(c.allowedHosts, host)) {
          return { allowed: false, reason: `Host "${host}" not in allowlist for ${toolName}`, ruleId: rule.id, userHint: USER_HINTS.policy };
        }
        if (c.blockedHosts && matchHost(c.blockedHosts, host)) {
          return { allowed: false, reason: `Host "${host}" is blocked by policy`, ruleId: rule.id, userHint: USER_HINTS.policy };
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
        return { allowed: false, reason: `Command "${firstWord}" not in allowlist`, ruleId: rule.id, userHint: USER_HINTS.commandShell };
      }
    }

    // Blocked args (string contains check)
    if (c.blockedArgs) {
      const argStr = JSON.stringify(args);
      for (const blocked of c.blockedArgs) {
        if (argStr.includes(blocked)) {
          return { allowed: false, reason: `Arguments contain blocked pattern "${blocked}"`, ruleId: rule.id, userHint: USER_HINTS.policy };
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
        return { allowed: false, reason: `Tool "${toolName}" exceeded max ${c.maxCallsPerSession} calls per session`, ruleId: rule.id, userHint: USER_HINTS.retryExhausted };
      }
    }

    return null;
  }

  /** Reset per-session call counts (call when session ends) */
  resetSession(sessionId: string): void {
    sessionCallCounts.delete(sessionId);
  }
}

/**
 * LiveToolPolicy — wraps ToolPolicy with file-watching hot-reload.
 * Merges user rules with defaults so critical rules (agent delegation, etc.)
 * can never be accidentally removed.
 */
export class LiveToolPolicy extends ToolPolicy {
  private policyPath: string;
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

  override findCoveringRule(toolName: string): string | null {
    return this.currentInner.findCoveringRule(toolName);
  }

  override resetSession(sessionId: string): void {
    this.currentInner.resetSession(sessionId);
  }

  private startWatching(): void {
    try {
      let debounce: ReturnType<typeof setTimeout> | null = null;
      watch(this.policyPath, () => {
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

/** Load tool policy from ~/.lax/tool-policy.json or use defaults */
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

// ── Boot-time coverage audit ─────────────────────────────────────────────
//
// Twice in one day (mission_schedule_*, then 10 more user-facing tools) a
// newly-registered ToolDefinition had no matching policy rule, hit
// deny-by-default at runtime, and the user saw "BLOCKED by tool-policy:
// Denied by default policy (no matching rule)" with no warning that the
// gap existed. This audit catches the gap AT BOOT — same shape as the
// existing security-audit pair.
//
// Since every policy decision now comes from an explicit rule in the unified
// table (the silent risk-tier fallback was removed), "uncovered" means a
// genuine orphan: a registered tool with no rule in tool-policies.data.ts.
// That is the orphan check the table refactor guarantees — also asserted by
// the tool-policy-default.test.ts unit test against TOOLS.
//
// Different from runtime evaluate(): we ignore argMatch/action/constraints
// and ask the structural question "does any rule's tool-pattern match this
// tool name?" A tool can be "covered" by a deny rule and still be unusable
// (e.g. swarm_cancel is covered by deny-swarm-cancel) — that's correct, the
// point is the catalog mentions it.

export interface PolicyCoverageReport {
  totalTools: number;
  /** Covered by a rule whose tool-pattern matches this name. */
  covered: string[];
  /** No matching rule at all — hits deny-by-default. Error-level. */
  uncovered: string[];
}

export function auditPolicyCoverage(toolNames: string[], policy: ToolPolicy): PolicyCoverageReport {
  const covered: string[] = [];
  const uncovered: string[] = [];
  for (const name of toolNames) {
    if (policy.findCoveringRule(name)) covered.push(name);
    else uncovered.push(name);
  }
  return { totalTools: toolNames.length, covered, uncovered };
}

export function printPolicyCoverageReport(report: PolicyCoverageReport): void {
  // Match the security-audit visual idiom (printAuditReport in security-audit.ts).
  logger.info(`\n  ── Tool-Policy Coverage ──`);
  if (report.uncovered.length === 0) {
    logger.info(`  \x1b[36mℹ\x1b[0m All ${report.totalTools} registered tools have a matching policy rule\n`);
    return;
  }
  logger.error(`  \x1b[31m✖\x1b[0m ${report.uncovered.length} of ${report.totalTools} tools have NO matching policy rule:`);
  for (const name of report.uncovered) logger.error(`    - ${name}`);
  logger.error(`  These will hit deny-by-default at runtime. Add the tool (with an explicit allow/deny rule) to src/tool-policy/tool-policies.data.ts.\n`);
}
