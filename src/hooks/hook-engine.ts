/**
 * Hook Engine — registry, dispatch, and execution of lifecycle hooks.
 *
 * Hooks are loaded from ~/.lax/hooks.json and fire on tool/session events.
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
import { getLaxDir } from "../lax-data-dir.js";
import type { HookDefinition, HookEvent, HookEventContext, HookResult, HooksConfig } from "./hook-types.js";
import { CREDENTIAL_ENV_PREFIXES } from "../security/secrets/index.js";

import { createLogger } from "../logger.js";
const logger = createLogger("hooks.hook-engine");

interface SecurityEvaluator {
  evaluate(ctx: { toolName: string; args: Record<string, unknown>; sessionId: string; callContext?: string }): { allowed: boolean; reason: string };
}

const HOOKS_PATH = join(getLaxDir(), "hooks.json");
const IS_WINDOWS = process.platform === "win32";

function scrubEnv(): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !CREDENTIAL_ENV_PREFIXES.test(k)) clean[k] = v;
  }
  return clean;
}

/**
 * A structured directive a PreToolUse hook can emit instead of relying on
 * exit-code semantics alone: JSON on stdout (command hooks) or in the response
 * body (http hooks) with any of `continue` / `reason` / `rewriteArgs`.
 * Returns null when the output isn't such a directive — the caller then falls
 * back to the legacy exit-code/status contract. Strict on purpose: the output
 * must BE a JSON object carrying at least one recognized key, so ordinary
 * command output (test logs, JSON data that happens to be printed) is never
 * misread as a control message.
 */
export function parseHookDirective(output: string): {
  continue?: boolean;
  reason?: string;
  rewriteArgs?: Record<string, unknown>;
} | null {
  const s = output.trim();
  if (!s.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const directive: { continue?: boolean; reason?: string; rewriteArgs?: Record<string, unknown> } = {};
  if (typeof o.continue === "boolean") directive.continue = o.continue;
  if (typeof o.reason === "string") directive.reason = o.reason;
  if (o.rewriteArgs && typeof o.rewriteArgs === "object" && !Array.isArray(o.rewriteArgs)) {
    directive.rewriteArgs = o.rewriteArgs as Record<string, unknown>;
  }
  if (directive.continue === undefined && directive.reason === undefined && directive.rewriteArgs === undefined) {
    return null;
  }
  return directive;
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
      logger.info(`[hooks] Loaded ${this.hooks.length} hooks from ${HOOKS_PATH}`);
    } catch (e) {
      logger.warn(`[hooks] Failed to load hooks: ${(e as Error).message}`);
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

  /** Fire hooks synchronously — used for PreToolUse (can block or rewrite).
   *  Rewrites CHAIN: each subsequent sync hook sees the args as rewritten by
   *  the hooks before it, and the final rewrite (if any differs from the
   *  original) is returned for the dispatcher to re-screen and apply. */
  async fire(ctx: HookEventContext): Promise<HookResult> {
    const matching = this.getHooks(ctx.event, ctx.toolName);
    if (matching.length === 0) return { continue: true };

    let effectiveArgs = ctx.toolArgs;
    for (const hook of matching) {
      if (hook.async) { this.runHookDetached(hook, ctx); continue; }
      const start = Date.now();
      let result: HookResult;
      try {
        result = await this.runHook(hook, { ...ctx, toolArgs: effectiveArgs });
      } catch (e) {
        result = { continue: true, output: `Hook error: ${(e as Error).message}` };
      }
      result.durationMs = Date.now() - start;
      const label = hook.name || `${hook.type}:${hook.event}`;
      logger.info(`[hooks] ${label} → ${result.continue ? "continue" : "BLOCKED"} (${result.durationMs}ms)`);
      if (!result.continue) return result;
      if (result.rewriteArgs && ctx.event === "PreToolUse") {
        logger.info(`[hooks] ${label} rewrote args for ${ctx.toolName}`);
        effectiveArgs = result.rewriteArgs;
      }
    }
    return {
      continue: true,
      ...(effectiveArgs !== ctx.toolArgs ? { rewriteArgs: effectiveArgs } : {}),
    };
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
        logger.info(`[hooks] ${label} (async) → ${r.continue ? "ok" : "blocked"}`);
      })
      .catch((e) => logger.warn(`[hooks] async hook error: ${(e as Error).message}`));
  }

  /** Protected so tests can subclass with a scripted hook runner. */
  protected runHook(hook: HookDefinition, ctx: HookEventContext): Promise<HookResult> {
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
        logger.warn(`[hooks] Command blocked by security: ${decision.reason}`);
        return Promise.resolve({ continue: true, output: `Hook command blocked by security: ${decision.reason}` });
      }
    }

    const timeout = (hook.timeout ?? 30) * 1000;

    // Scrubbed env + hook-specific context vars. Args are exposed to COMMAND
    // hooks only (a local script the user wrote, running with a scrubbed env)
    // so a rewriting hook can read what it is rewriting; http hooks keep the
    // existing no-raw-args rule.
    const hookEnv = {
      ...scrubEnv(),
      HOOK_TOOL_NAME: ctx.toolName || "",
      HOOK_TOOL_ARGS: ctx.toolArgs ? JSON.stringify(ctx.toolArgs).slice(0, 8000) : "",
      HOOK_TOOL_RESULT: (ctx.toolResult || "").slice(0, 1000),
      HOOK_TOOL_ERROR: (ctx.toolError || "").slice(0, 500),
      HOOK_SESSION_ID: ctx.sessionId || "",
      HOOK_EVENT: ctx.event,
      HOOK_OP_ID: ctx.opId || "",
      HOOK_OP_STATUS: ctx.opStatus || "",
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
        // A JSON directive on stdout refines the exit-code contract: explicit
        // continue/reason win over the exit code, and a rewrite is honored
        // only on a continuing PreToolUse hook.
        const directive = ctx.event === "PreToolUse" ? parseHookDirective(stdout || "") : null;
        const shouldContinue = directive?.continue ?? (ctx.event !== "PreToolUse" || !error);
        resolve({
          continue: shouldContinue,
          reason: shouldContinue ? undefined : (directive?.reason ?? `Hook blocked: ${output || "non-zero exit"}`),
          output,
          ...(shouldContinue && directive?.rewriteArgs ? { rewriteArgs: directive.rewriteArgs } : {}),
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
          ...(ctx.opId ? { opId: ctx.opId } : {}),
          ...(ctx.opStatus ? { opStatus: ctx.opStatus } : {}),
        }),
        signal: AbortSignal.timeout(timeout),
      });
      const body = await res.text();
      // A JSON directive in the response body refines the status-code contract
      // (same shape as command-hook stdout). Note: http hooks never see the raw
      // args, so their rewrites are limited to what the event metadata supports.
      const directive = ctx.event === "PreToolUse" ? parseHookDirective(body) : null;
      const shouldContinue = directive?.continue ?? (ctx.event !== "PreToolUse" || res.ok);
      return {
        continue: shouldContinue,
        reason: shouldContinue ? undefined : (directive?.reason ?? `Webhook returned ${res.status}`),
        output: body.slice(0, 500),
        ...(shouldContinue && directive?.rewriteArgs ? { rewriteArgs: directive.rewriteArgs } : {}),
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
