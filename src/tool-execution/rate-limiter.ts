/**
 * Tool Rate Limiter
 *
 * Configurable per-tool rate limits using a sliding window.
 */
import { USER_HINTS } from "../types.js";
import { deriveRateLimits } from "../tool-policy/tool-policies.js";

export interface RateLimitConfig {
  /** Tool name or "*" for global */
  tool: string;
  /** Maximum calls allowed in the window */
  maxCalls: number;
  /** Window size in milliseconds */
  windowMs: number;
  /** Action when limit exceeded */
  action: "block" | "warn" | "throttle";
}

interface RateLimitState {
  timestamps: number[];
}

interface RateLimitResult {
  allowed: boolean;
  action: "block" | "warn" | "throttle" | "allow";
  remaining: number;
  resetInMs: number;
  reason?: string;
  /** Plain-English user-facing summary; see SecurityDecision.userHint. */
  userHint?: string;
}

// Per-tool sliding-window caps, derived from the unified policy table
// (tool-policies.data.ts rateLimit entries + the global "*" cap).
const DEFAULT_LIMITS: RateLimitConfig[] = deriveRateLimits();

export class ToolRateLimiter {
  private configs: RateLimitConfig[];
  private state: Map<string, RateLimitState> = new Map();

  constructor(configs?: RateLimitConfig[]) {
    this.configs = configs || [...DEFAULT_LIMITS];
  }

  /** Check if a tool call is within rate limits */
  check(toolName: string, sessionId: string = "default"): RateLimitResult {
    const now = Date.now();

    // Check tool-specific limits
    const toolConfig = this.configs.find(c => c.tool === toolName);
    if (toolConfig) {
      const result = this.checkLimit(toolConfig, toolName, sessionId, now);
      if (!result.allowed) return result;
    }

    // Check global limit
    const globalConfig = this.configs.find(c => c.tool === "*");
    if (globalConfig) {
      return this.checkLimit(globalConfig, "*", sessionId, now);
    }

    return { allowed: true, action: "allow", remaining: -1, resetInMs: 0 };
  }

  /** Record a tool call (call after check passes) */
  record(toolName: string, sessionId: string = "default"): void {
    const now = Date.now();
    // Record for tool-specific key
    this.addTimestamp(`${sessionId}:${toolName}`, now);
    // Record for global key
    this.addTimestamp(`${sessionId}:*`, now);
  }

  private checkLimit(config: RateLimitConfig, tool: string, sessionId: string, now: number): RateLimitResult {
    const key = `${sessionId}:${tool}`;
    const state = this.state.get(key);
    if (!state) {
      return { allowed: true, action: "allow", remaining: config.maxCalls, resetInMs: 0 };
    }

    // Clean old timestamps outside window
    const windowStart = now - config.windowMs;
    const recent = state.timestamps.filter(t => t > windowStart);
    state.timestamps = recent;

    const remaining = config.maxCalls - recent.length;
    const resetInMs = recent.length > 0 ? (recent[0] + config.windowMs) - now : 0;

    if (remaining <= 0) {
      const allowed = config.action !== "block";
      return {
        allowed,
        action: config.action,
        remaining: 0,
        resetInMs: Math.max(0, resetInMs),
        reason: `Rate limit exceeded for ${tool}: ${config.maxCalls} calls per ${config.windowMs / 1000}s`,
        ...(allowed ? {} : { userHint: USER_HINTS.retryExhausted }),
      };
    }

    return { allowed: true, action: "allow", remaining, resetInMs: 0 };
  }

  private addTimestamp(key: string, timestamp: number): void {
    let state = this.state.get(key);
    if (!state) {
      state = { timestamps: [] };
      this.state.set(key, state);
    }
    state.timestamps.push(timestamp);
    // Keep only timestamps within the largest window
    const maxWindow = Math.max(...this.configs.map(c => c.windowMs));
    const cutoff = timestamp - maxWindow;
    state.timestamps = state.timestamps.filter(t => t > cutoff);
  }

  /** Update rate limit config for a tool */
  setLimit(tool: string, maxCalls: number, windowMs: number, action: "block" | "warn" | "throttle" = "block"): void {
    const existing = this.configs.findIndex(c => c.tool === tool);
    const config: RateLimitConfig = { tool, maxCalls, windowMs, action };
    if (existing >= 0) {
      this.configs[existing] = config;
    } else {
      this.configs.push(config);
    }
  }

  /** Remove rate limit for a tool */
  removeLimit(tool: string): boolean {
    const before = this.configs.length;
    this.configs = this.configs.filter(c => c.tool !== tool);
    return this.configs.length < before;
  }

  /** Get all current rate limit configs */
  getLimits(): RateLimitConfig[] {
    return [...this.configs];
  }

  /** Get current usage stats for a session */
  getUsage(sessionId: string = "default"): Record<string, { used: number; limit: number; windowMs: number }> {
    const now = Date.now();
    const usage: Record<string, { used: number; limit: number; windowMs: number }> = {};

    for (const config of this.configs) {
      const key = `${sessionId}:${config.tool}`;
      const state = this.state.get(key);
      const windowStart = now - config.windowMs;
      const recent = state ? state.timestamps.filter(t => t > windowStart).length : 0;
      usage[config.tool] = { used: recent, limit: config.maxCalls, windowMs: config.windowMs };
    }

    return usage;
  }

  /** Reset all rate limit state */
  reset(): void {
    this.state.clear();
  }
}

// Singleton
const rateLimiter = new ToolRateLimiter();

export function checkToolRateLimit(toolName: string, sessionId?: string): RateLimitResult {
  return rateLimiter.check(toolName, sessionId);
}

export function recordToolCall(toolName: string, sessionId?: string): void {
  rateLimiter.record(toolName, sessionId);
}

export function getToolRateLimiter(): ToolRateLimiter {
  return rateLimiter;
}
