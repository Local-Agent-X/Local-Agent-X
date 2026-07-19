import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createLogger } from "../logger.js";
import { checkRegexSafety } from "../safe-regex.js";
import { matchArgPattern, matchGlob, matchHost } from "./matchers.js";
import { mergeWithDefaults, stampedDefaultPolicy } from "./merge-defaults.js";
import type { PolicyDecision, ToolPolicyConfig, ToolPolicyRule } from "./types.js";
import { USER_HINTS } from "../types.js";

const logger = createLogger("tool-policy");

export type { PolicyDecision, ToolPolicyConfig, ToolPolicyRule } from "./types.js";
export { mergeWithDefaults, snapshotHashOf, stampedDefaultPolicy } from "./merge-defaults.js";

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

// Track per-session, per-tool rate-limit windows. Each entry is a fixed time
// window: `windowStart` is when the current window opened and `count` is how
// many ALLOWED calls it has admitted so far.
interface RateWindow { windowStart: number; count: number; }
const sessionCallCounts = new Map<string, Map<string, RateWindow>>();

// `maxCallsPerSession` is enforced as a rolling fixed window rather than a
// lifetime cap. A lifetime cap permanently bricks the tool once exceeded —
// the counter was only ever cleared by resetSession(), which has no production
// caller, so a long conversation would lose bash forever after the 30th call
// (and sql/mcp/voice likewise). A time window self-heals while still throttling
// runaway loops. 60s matches the sibling rateLimit.windowMs used across the
// tool manifest.
const RATE_LIMIT_WINDOW_MS = 60_000;

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

  /** Exact-name counterpart used by external plugin activation. A glob rule
   *  can cover built-ins, but must never silently authorize a new executable
   *  name contributed at runtime. */
  findExactRule(toolName: string): string | null {
    return this.config.rules.find((rule) => rule.tool === toolName)?.id ?? null;
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

    // Per-session rate limit — enforced as a self-healing fixed time window so
    // an exhausted limit recovers on the next window instead of locking the
    // tool out for the life of the process. Denied calls do NOT consume quota,
    // so a loop hammering an already-blocked tool cannot keep extending its own
    // lockout.
    if (c.maxCallsPerSession) {
      let sessionMap = sessionCallCounts.get(sessionId);
      if (!sessionMap) {
        sessionMap = new Map();
        sessionCallCounts.set(sessionId, sessionMap);
      }
      const now = Date.now();
      const win = sessionMap.get(toolName);
      if (!win || now - win.windowStart >= RATE_LIMIT_WINDOW_MS) {
        // Fresh window — first call is always admitted.
        sessionMap.set(toolName, { windowStart: now, count: 1 });
      } else if (win.count >= c.maxCallsPerSession) {
        return { allowed: false, reason: `Tool "${toolName}" exceeded max ${c.maxCallsPerSession} calls per ${RATE_LIMIT_WINDOW_MS / 1000}s — retry shortly`, ruleId: rule.id, userHint: USER_HINTS.retryExhausted };
      } else {
        win.count++;
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

  override findExactRule(toolName: string): string | null {
    return this.currentInner.findExactRule(toolName);
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
  // Write default policy to disk on first run (so audit doesn't warn about
  // missing file) — STAMPED, so future default-decision changes in code can
  // tell this snapshot apart from a user edit and refresh it (merge-defaults.ts).
  const stamped = stampedDefaultPolicy();
  try {
    writeFileSync(policyPath, JSON.stringify(stamped, null, 2), { encoding: "utf-8", mode: 0o600 });
    logger.info(`[policy] Created default policy at ${policyPath}`);
  } catch {}
  return new LiveToolPolicy(new ToolPolicy(stamped), policyPath);
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
