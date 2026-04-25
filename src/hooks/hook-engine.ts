/**
 * Hook Engine — registry, dispatch, and execution of lifecycle hooks.
 *
 * Hooks are loaded from ~/.sax/hooks.json and fire on tool/session events.
 * Command hooks run shell commands. HTTP hooks POST to localhost-only URLs.
 *
 * Safety:
 * - Command hooks use a scrubbed env (no API keys/tokens leaked)
 * - HTTP hooks only POST to localhost/127.0.0.1 (no external exfiltration)
 * - PostToolUse hooks receive budgeted/sanitized results only
 * - Async hooks run detached (fire-and-forget, never block)
 */

import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { HookDefinition, HookEvent, HookEventContext, HookResult, HooksConfig } from "./hook-types.js";

interface SecurityEvaluator {
  evaluate(ctx: { toolName: string; args: Record<string, unknown>; sessionId: string; callContext?: string }): { allowed: boolean; reason: string };
}

const HOOKS_PATH = join(homedir(), ".lax", "hooks.json");
const IS_WINDOWS = process.platform === "win32";

// Env vars that must NOT leak to hook commands
const SCRUB_KEYS = /^(ANTHROPIC_|OPENAI_|XAI_|SMTP_|IMAP_|GITHUB_|SLACK_|DISCORD_|BRAVE_|GEMINI_|CUSTOM_|DEEPSEEK_|MOONSHOT_|DASHSCOPE_).*|.*_(KEY|TOKEN|SECRET|PASS|PASSWORD)$/i;

function scrubEnv(): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !SCRUB_KEYS.test(k)) clean[k] = v;
  }
  return clean;
}

export class HookEngine {
  private hooks: HookDefinition[] = [];
  private security: SecurityEvaluator | null = null;

  constructor(security?: SecurityEvaluator) {
    this.security = security ?? null;
    this.reload();
  }

  /** Attach security layer (can be set after construction) */
  setSecurity(security: SecurityEvaluator): void { this.security = security; }

  reload(): void {
    try {
      if (!existsSync(HOOKS_PATH)) { this.hooks = []; return; }
      const config = JSON.parse(readFileSync(HOOKS_PATH, "utf-8")) as HooksConfig;
      this.hooks = Array.isArray(config.hooks) ? config.hooks : [];
      console.log(`[hooks] Loaded ${this.hooks.length} hooks from ${HOOKS_PATH}`);
    } catch (e) {
      console.warn(`[hooks] Failed to load hooks: ${(e as Error).message}`);
      this.hooks = [];
    }
  }

  private getHooks(event: HookEvent, toolName?: string): HookDefinition[] {
    return this.hooks.filter((h) => {
      if (h.event !== event) return false;
      if (h.toolFilter && toolName && h.toolFilter !== toolName) return false;
      return true;
    });
  }

  /** Fire hooks synchronously — used for PreToolUse (can block). */
  async fire(ctx: HookEventContext): Promise<HookResult> {
    const matching = this.getHooks(ctx.event, ctx.toolName);
    if (matching.length === 0) return { continue: true };

    for (const hook of matching) {
      if (hook.async) { this.runHookDetached(hook, ctx); continue; }
      const start = Date.now();
      let result: HookResult;
      try {
        result = await this.runHook(hook, ctx);
      } catch (e) {
        result = { continue: true, output: `Hook error: ${(e as Error).message}` };
      }
      result.durationMs = Date.now() - start;
      const label = hook.name || `${hook.type}:${hook.event}`;
      console.log(`[hooks] ${label} → ${result.continue ? "continue" : "BLOCKED"} (${result.durationMs}ms)`);
      if (!result.continue) return result;
    }
    return { continue: true };
  }

  /** Fire hooks fully detached — used for PostToolUse/PostToolUseFailure (never block). */
  fireDetached(ctx: HookEventContext): void {
    const matching = this.getHooks(ctx.event, ctx.toolName);
    for (const hook of matching) this.runHookDetached(hook, ctx);
  }

  private runHookDetached(hook: HookDefinition, ctx: HookEventContext): void {
    this.runHook(hook, ctx)
      .then((r) => {
        const label = hook.name || `${hook.type}:${hook.event}`;
        console.log(`[hooks] ${label} (async) → ${r.continue ? "ok" : "blocked"}`);
      })
      .catch((e) => console.warn(`[hooks] async hook error: ${(e as Error).message}`));
  }

  private runHook(hook: HookDefinition, ctx: HookEventContext): Promise<HookResult> {
    if (hook.type === "command") return this.runCommand(hook, ctx);
    if (hook.type === "http") return this.runHttp(hook, ctx);
    return Promise.resolve({ continue: true });
  }

  /** Execute a shell command hook with scrubbed env + security evaluation */
  private runCommand(hook: HookDefinition, ctx: HookEventContext): Promise<HookResult> {
    const cmd = hook.command;
    if (!cmd) return Promise.resolve({ continue: true, output: "No command specified" });

    // Route through security layer (same checks as bash tool calls, same callContext)
    if (this.security) {
      const decision = this.security.evaluate({
        toolName: "bash",
        args: { command: cmd },
        sessionId: ctx.sessionId || "hook",
        callContext: ctx.callContext as "local" | "api" | "delegated" | "cron" | undefined,
      });
      if (!decision.allowed) {
        console.warn(`[hooks] Command blocked by security: ${decision.reason}`);
        return Promise.resolve({ continue: true, output: `Hook command blocked by security: ${decision.reason}` });
      }
    }

    const timeout = (hook.timeout ?? 30) * 1000;

    // Scrubbed env + hook-specific context vars
    const hookEnv = {
      ...scrubEnv(),
      HOOK_TOOL_NAME: ctx.toolName || "",
      HOOK_TOOL_RESULT: (ctx.toolResult || "").slice(0, 1000),
      HOOK_TOOL_ERROR: (ctx.toolError || "").slice(0, 500),
      HOOK_SESSION_ID: ctx.sessionId || "",
      HOOK_EVENT: ctx.event,
    };

    // Platform-appropriate shell
    const shell = IS_WINDOWS ? "cmd.exe" : "bash";
    const shellArgs = IS_WINDOWS ? ["/c", cmd] : ["-c", cmd];

    return new Promise((resolve) => {
      const child = execFile(shell, shellArgs, { timeout, maxBuffer: 1024 * 1024, env: hookEnv }, (error, stdout, stderr) => {
        if (error && (error as Error & { killed?: boolean }).killed) {
          resolve({ continue: true, output: `Hook timed out after ${timeout}ms` });
          return;
        }
        const output = (stdout || "").trim() + (stderr ? `\n${stderr.trim()}` : "");
        const shouldContinue = ctx.event !== "PreToolUse" || !error;
        resolve({
          continue: shouldContinue,
          reason: shouldContinue ? undefined : `Hook blocked: ${output || "non-zero exit"}`,
          output,
        });
      });
      child.stdin?.end();
    });
  }

  /** Execute an HTTP webhook — localhost only (no external exfiltration) */
  private async runHttp(hook: HookDefinition, ctx: HookEventContext): Promise<HookResult> {
    const url = hook.url;
    if (!url) return { continue: true, output: "No URL specified" };

    // Security: only allow localhost URLs
    try {
      const parsed = new URL(url);
      const host = parsed.hostname;
      if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
        return { continue: true, output: `HTTP hook blocked: only localhost URLs allowed (got ${host})` };
      }
    } catch { return { continue: true, output: `HTTP hook blocked: invalid URL` }; }

    const timeout = (hook.timeout ?? 30) * 1000;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: ctx.event,
          toolName: ctx.toolName,
          sessionId: ctx.sessionId,
          timestamp: new Date().toISOString(),
          // Only include result/error, never raw args (may contain sensitive data)
          ...(ctx.toolResult ? { toolResult: ctx.toolResult.slice(0, 2000) } : {}),
          ...(ctx.toolError ? { toolError: ctx.toolError.slice(0, 500) } : {}),
        }),
        signal: AbortSignal.timeout(timeout),
      });
      const body = await res.text();
      const shouldContinue = ctx.event !== "PreToolUse" || res.ok;
      return {
        continue: shouldContinue,
        reason: shouldContinue ? undefined : `Webhook returned ${res.status}`,
        output: body.slice(0, 500),
      };
    } catch (e) {
      return { continue: true, output: `Webhook failed: ${(e as Error).message}` };
    }
  }

  get hasHooks(): boolean { return this.hooks.length > 0; }
  get count(): number { return this.hooks.length; }
}

let _engine: HookEngine | null = null;
export function getHookEngine(): HookEngine {
  if (!_engine) _engine = new HookEngine();
  return _engine;
}

/** Initialize hook engine with security layer (called from server startup) */
export function initHookEngine(security: SecurityEvaluator): HookEngine {
  const engine = getHookEngine();
  engine.setSecurity(security);
  return engine;
}
