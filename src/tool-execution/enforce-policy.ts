// Policy phase: AriKernel gate, session policy, worktree path rewrite,
// shared pre-dispatch chain (security/rbac/tool-policy), data-lineage egress,
// tool lookup, arg coercion + schema validation, PreToolUse hook, circuit
// breaker, rate limit. Sets ctx.preBlocked on pre-dispatch / unknown-tool
// failures (those flow through to audit); terminates outright on every
// other policy failure.

import { USER_HINTS, type ToolResult } from "../types.js";
import { ariEvaluate, ariObserve, isAriActive, shouldGateInKernel, shouldObserveInKernel } from "../ari-kernel/index.js";
import { checkSessionPolicy } from "../session/policy.js";
import { checkEgressTaint } from "../data-lineage.js";
import { getHookEngine } from "../hooks/hook-engine.js";
import { checkCircuit } from "../circuit-breaker.js";
import { checkToolRateLimit } from "./rate-limiter.js";
import { logRetry } from "../retry-telemetry.js";
import { assertToolCallAllowed } from "../tools/pre-dispatch.js";
import { ToolBlocked } from "./errors.js";
import { join, resolve, relative } from "node:path";
import type { Phase, PhaseOutcome, ToolCallContext } from "./context.js";
import { terminate, CONTINUE, BLOCK } from "./context.js";

// HOST_CAPABILITY_MANIFEST action names — see ari-kernel.ts. A non-shell
// tool that falls through to "exec" → lookupHostGrantId returns undefined
// → firewall.execute throws → ariRequired turns it into a block. Every
// gated tool must map to a manifest-valid action.
const ARI_ACTION_MAP: Record<string, string> = {
  read: "read", write: "write", edit: "write",
  web_search: "get", web_fetch: "get", http_request: "get", browser: "get",
  bash: "exec",
  memory_search: "search",
  // ARI database toolClass declares actions [query, exec, mutate] — "write"
  // is not in that set, so action="write" tripped deny-by-default at the
  // policy engine. memory_save is a row insert into the daily-log SQLite
  // table, which maps cleanly to mutate.
  memory_save: "mutate",
  // secret-vault actions are overridden inside ariEvaluate by
  // secretVaultActionMap; "capture" is just a valid no-op default.
  browser_capture_to_secret: "capture",
  browser_fill_from_secret: "fill",
  clipboard_write_from_secret: "clipboard",
  // file
  glob: "read", grep: "read", view_image: "read", send_video: "read", delete_file: "write",
  // http — get for read paths, post for mutations
  calendar_check_availability: "get", calendar_list_events: "get",
  calendar_create_event: "post",
  email_read: "get", email_search: "get", email_draft: "post",
  email_send: "post", email_setup: "post",
  marketplace_search: "get", marketplace_list: "get", marketplace_install: "get",
  extract_site_assets: "get",
  youtube_analyze: "get",
  // shell — subprocess spawns + OS process queries
  process_start: "exec", process_status: "exec",
  process_kill: "exec", process_list: "exec",
  // database — SQL (read-class today; tools self-restrict writes)
  sql_query: "query", sql_explain: "query", sql_schema: "query",
  // retrieval — vector/keyword session search
  search_past_sessions: "search",
};

async function ariKernelGate(ctx: ToolCallContext): Promise<PhaseOutcome> {
  const { tc, args, sessionId } = ctx;
  if (isAriActive() && shouldGateInKernel(tc.name)) {
    const ariResult = await ariEvaluate(tc.name, ARI_ACTION_MAP[tc.name] || "exec", args);
    if (!ariResult.allowed) {
      const hint = ariResult.userHint ?? USER_HINTS.policy;
      return terminate(ctx, { rendered: "raw", content: `User hint: ${hint}\n${ariResult.reason}`, allowed: false });
    }
  } else if (isAriActive() && shouldObserveInKernel(tc.name)) {
    // Audit-only path for internal-class tools — never blocks.
    ariObserve(tc.name, "internal", args, { sessionId });
  }
  return CONTINUE;
}

function sessionPolicyGate(ctx: ToolCallContext): PhaseOutcome {
  const block = checkSessionPolicy(ctx.sessionId || "default", ctx.tc.name);
  if (block) {
    return terminate(ctx, { rendered: "raw", content: `User hint: ${USER_HINTS.policy}\n${block}`, allowed: false });
  }
  return CONTINUE;
}

// Worktree enforcement: rewrite paths BEFORE the security pre-dispatch
// chain so security evaluates the actual path.
async function rewriteWorktreePaths(ctx: ToolCallContext): Promise<void> {
  const { tc, args, sessionId } = ctx;
  if (!sessionId?.startsWith("agent-")) return;
  try {
    const agentId = sessionId.slice(6);
    const { getWorktreePath } = await import("../agency/worktree.js");
    const wtPath = getWorktreePath(agentId);
    if (!wtPath) return;
    const pathTools = ["read", "write", "edit", "glob", "grep"];
    if (pathTools.includes(tc.name) && args.path) {
      const rawPath = String(args.path);
      const isAbsolute = rawPath.startsWith("/") || rawPath.includes(":");
      if (isAbsolute) {
        if (["glob", "grep"].includes(tc.name)) {
          const resolved = resolve(rawPath);
          if (relative(wtPath, resolved).startsWith("..")) {
            args.path = wtPath;
          }
        }
      } else {
        args.path = join(wtPath, rawPath);
      }
    }
    if (["glob", "grep"].includes(tc.name) && !args.path) {
      args.path = wtPath;
    }
    if (tc.name === "bash") args._cwd = wtPath;
  } catch { /* worktree module not available */ }
}

// Pre-dispatch chain blocks set ctx.result and return BLOCK. Audit still
// runs (so the block message can be re-examined by threat engine + hooks).
async function runPreDispatch(ctx: ToolCallContext): Promise<PhaseOutcome> {
  const { tc, args, sessionId, callContext, security, rbac, callerRole, toolPolicy } = ctx;
  try {
    await assertToolCallAllowed(
      { id: tc.id, name: tc.name, args },
      {
        sessionId: sessionId || "default",
        callContext,
        skipSessionPolicy: true,
        security,
        rbac: rbac && callerRole ? { manager: rbac, role: callerRole } : undefined,
        toolPolicy,
      },
    );
  } catch (e) {
    if (!(e instanceof ToolBlocked)) throw e;
    const layerMap: Record<typeof e.stage, string> = {
      "session-policy": "session-policy",
      "security": "security",
      "rbac": "rbac",
      "tool-policy": "tool-policy",
      "threat": "threat",
      "arikernel": "arikernel",
      "approval": "approval",
    };
    ctx.allowed = false;
    ctx.result = {
      content: e.message,
      isError: true,
      status: "blocked",
      metadata: { layer: layerMap[e.stage], recovery: e.recovery, userHint: e.userHint },
    };
    return BLOCK;
  }
  return CONTINUE;
}

function dataLineageGate(ctx: ToolCallContext): PhaseOutcome {
  if (!["http_request", "web_fetch"].includes(ctx.tc.name)) return CONTINUE;
  const egress = checkEgressTaint(ctx.sessionId || "default");
  if (!egress.blocked) return CONTINUE;
  const result: ToolResult = {
    content: `BLOCKED by data lineage: ${egress.reason}`,
    isError: true,
    status: "blocked",
    metadata: { layer: "data-lineage", recovery: "Sensitive data was tainted earlier this session and may not egress. Either don't include the tainted data or end the session.", userHint: USER_HINTS.network },
  };
  return terminate(ctx, { rendered: "model", result, allowed: false });
}

function lookupTool(ctx: ToolCallContext): PhaseOutcome {
  const tool = ctx.toolMap.get(ctx.tc.name);
  if (!tool) {
    ctx.allowed = false;
    ctx.result = {
      content: `Unknown tool: ${ctx.tc.name}`,
      isError: true,
      status: "error",
      metadata: { recovery: "Tool name typo or the tool isn't registered. Use tool_search to find the right name." },
    };
    return BLOCK;
  }
  ctx.tool = tool;
  return CONTINUE;
}

// Weak models emit malformed args. Lightweight required[] + type checks on
// top-level fields; safe scalar coercion ("5" → 5) before validation.
async function validateArgs(ctx: ToolCallContext): Promise<PhaseOutcome> {
  const { tc, tool, sessionId } = ctx;
  if (!tool) return CONTINUE;
  const schema = tool.parameters as { type?: string; properties?: Record<string, { type?: string; enum?: unknown[] }>; required?: string[] } | undefined;

  if (schema && typeof ctx.args === "object" && ctx.args && !("_raw" in ctx.args)) {
    try {
      const { coerceArgs } = await import("./arg-repair.js");
      const coerce = coerceArgs(ctx.args as Record<string, unknown>, schema);
      if (coerce.fixes.length > 0) {
        ctx.args = coerce.coerced;
        logRetry({ kind: "tool-arg-invalid", sessionId, tool: tc.name, detail: { phase: "coerce", fixes: coerce.fixes } });
      }
    } catch {}
  }

  if (!schema?.properties) return CONTINUE;
  const errs: string[] = [];
  for (const req of schema.required || []) {
    if (!(req in ctx.args)) errs.push(`missing required field "${req}"`);
  }
  for (const [key, propSchema] of Object.entries(schema.properties)) {
    if (!(key in ctx.args)) continue;
    const val = (ctx.args as Record<string, unknown>)[key];
    if (propSchema.type === "string" && typeof val !== "string") errs.push(`"${key}" must be a string (got ${typeof val})`);
    else if (propSchema.type === "number" && typeof val !== "number") errs.push(`"${key}" must be a number (got ${typeof val})`);
    else if (propSchema.type === "boolean" && typeof val !== "boolean") errs.push(`"${key}" must be a boolean (got ${typeof val})`);
    else if (propSchema.type === "array" && !Array.isArray(val)) errs.push(`"${key}" must be an array (got ${typeof val})`);
    if (propSchema.enum && !propSchema.enum.includes(val)) errs.push(`"${key}" must be one of [${propSchema.enum.map(v => JSON.stringify(v)).join(", ")}] (got ${JSON.stringify(val)})`);
  }
  if (errs.length === 0) return CONTINUE;

  const result: ToolResult = {
    content: `Invalid arguments for ${tc.name}: ${errs.join("; ")}. Fix and retry.`,
    isError: true,
    status: "error",
    metadata: { recovery: "Schema validation failed — fix the listed fields and retry. This is NOT a policy denial; the tool itself is available." },
  };
  return terminate(ctx, { rendered: "model", result, allowed: false });
}

async function preToolUseHook(ctx: ToolCallContext): Promise<PhaseOutcome> {
  const { tc, args, sessionId, callContext } = ctx;
  const hookEngine = getHookEngine();
  if (!hookEngine.hasHooks) return CONTINUE;
  const preHook = await hookEngine.fire({ event: "PreToolUse", toolName: tc.name, toolArgs: args, sessionId, callContext });
  if (preHook.continue) return CONTINUE;
  const result: ToolResult = {
    content: `BLOCKED by hook: ${preHook.reason || "PreToolUse hook returned false"}`,
    isError: true,
    status: "blocked",
    metadata: { layer: "hook", recovery: "A user-configured hook blocked this call. Check ~/.lax/hooks.json or proceed without the gated action.", userHint: USER_HINTS.policy },
  };
  return terminate(ctx, { rendered: "model", result, allowed: false });
}

function circuitBreakerGate(ctx: ToolCallContext): PhaseOutcome {
  const { tc, sessionId } = ctx;
  const circuit = checkCircuit(sessionId, tc.name);
  if (circuit.allowed) return CONTINUE;
  const result: ToolResult = {
    content: `BLOCKED by circuit breaker: ${circuit.reason}`,
    isError: true,
    status: "blocked",
    metadata: { layer: "circuit-breaker", recovery: "This tool has failed repeatedly in this session. Stop calling it and use an alternative — the breaker will reset after several successful unrelated calls.", userHint: circuit.userHint ?? USER_HINTS.retryExhausted },
  };
  return terminate(ctx, { rendered: "model", result, allowed: false });
}

function rateLimitGate(ctx: ToolCallContext): PhaseOutcome {
  const { tc, sessionId } = ctx;
  const rate = checkToolRateLimit(tc.name, sessionId);
  if (rate.allowed) return CONTINUE;
  const result: ToolResult = {
    content: `BLOCKED by rate limit: ${rate.reason}`,
    isError: true,
    status: "blocked",
    metadata: { layer: "rate-limit", recovery: "Per-tool rate limit hit. Wait or batch fewer calls; immediate retries will keep being denied.", userHint: rate.userHint ?? USER_HINTS.retryExhausted },
  };
  return terminate(ctx, { rendered: "model", result, allowed: false });
}

export const enforcePolicyPhase: Phase = async (ctx) => {
  let outcome = await ariKernelGate(ctx);
  if (outcome.kind !== "continue") return outcome;
  outcome = sessionPolicyGate(ctx);
  if (outcome.kind !== "continue") return outcome;
  await rewriteWorktreePaths(ctx);

  outcome = await runPreDispatch(ctx);
  if (outcome.kind !== "continue") return outcome;
  outcome = dataLineageGate(ctx);
  if (outcome.kind !== "continue") return outcome;

  outcome = lookupTool(ctx);
  if (outcome.kind !== "continue") return outcome;
  outcome = await validateArgs(ctx);
  if (outcome.kind !== "continue") return outcome;

  outcome = await preToolUseHook(ctx);
  if (outcome.kind !== "continue") return outcome;
  outcome = circuitBreakerGate(ctx);
  if (outcome.kind !== "continue") return outcome;
  return rateLimitGate(ctx);
};
