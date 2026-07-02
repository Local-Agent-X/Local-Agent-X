// Policy phase: AriKernel gate, session policy, worktree path rewrite,
// shared pre-dispatch chain (security/rbac/tool-policy), data-lineage egress,
// tool lookup, arg coercion + schema validation, PreToolUse hook, circuit
// breaker, rate limit. Sets ctx.preBlocked on pre-dispatch / unknown-tool
// failures (those flow through to audit); terminates outright on every
// other policy failure.

import { USER_HINTS, type ToolResult } from "../types.js";
import { ariEvaluate, ariObserve, isAriActive, shouldGateInKernel, shouldObserveInKernel } from "../ari-kernel/index.js";
import { checkSessionPolicy } from "../session/policy.js";
import { getKernelTaintSources } from "../data-lineage.js";
import { WORKTREE_PATH_TOOLS } from "../tool-registry.js";
import { taintedShellBlockReason, blockedSelfVerifyGuidance } from "./shell-block-guidance.js";
import { getHookEngine } from "../hooks/hook-engine.js";
import { checkCircuit, circuitArgsSig } from "../circuit-breaker.js";
import { checkToolRateLimit } from "./rate-limiter.js";
import { logRetry } from "../retry-telemetry.js";
import { assertToolCallAllowed } from "../tools/pre-dispatch.js";
import { ToolBlocked } from "./errors.js";
import { join, resolve, relative } from "node:path";
import type { Phase, PhaseOutcome, ToolCallContext } from "./context.js";
import { terminate, CONTINUE, BLOCK } from "./context.js";
import { egressGuardGate, dataLineageGate, canaryEgressGate } from "./egress-gates.js";

export { egressGuardGate, dataLineageGate, canaryEgressGate } from "./egress-gates.js";

// HOST_CAPABILITY_MANIFEST action names — see ari-kernel.ts. A non-shell
// tool that falls through to "exec" → lookupHostGrantId returns undefined
// → firewall.execute throws → ariRequired turns it into a block. Every
// gated tool must map to a manifest-valid action. Exported for the
// coverage test (ari-action-map.test.ts) that fails when a kernel-gated
// tool ships without a mapping — image_search did exactly that
// (2026-06-10): action fell through to "exec", the http schema rejected
// it, and every call blocked as "ARI error (ariRequired mode)".
export const ARI_ACTION_MAP: Record<string, string> = {
  read: "read", write: "write", edit: "write", edit_lines: "write", multi_edit: "write",
  web_search: "get", web_fetch: "get", http_request: "get", browser: "get",
  image_search: "get",
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
  glob: "read", grep: "read", view_image: "read", send_video: "read", send_image: "read", delete_file: "write",
  // http — get for read paths, post for mutations
  calendar_check_availability: "get", calendar_list_events: "get",
  calendar_create_event: "post",
  email_read: "get", email_search: "get", email_draft: "post",
  email_send: "post", email_setup: "post", telegram_send: "post", whatsapp_send: "post",
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
  if (shouldGateInKernel(tc.name)) {
    // Every gated tool goes through the single ARI decision. ariEvaluate
    // fail-closes when the kernel is required but inactive (firewall === null
    // && ariRequired), so an ARI that failed to start can't silently leave
    // gated I/O ungated — it blocks. Guarding this branch on isAriActive()
    // (as it once did) made that fail-closed path unreachable: an inactive
    // kernel skipped the gate entirely.
    // Feed the live session's taint (recorded by data-lineage when a
    // sensitive/web/rag read occurred) into the kernel as the 4th arg, so the
    // kernel's behavioral deny-tainted-shell / deny-tainted-http rules actually
    // fire. Without this the kernel always saw empty taint and those rules were
    // dead code. The MODEL can't supply taint — it comes from the trusted
    // runtime tracker keyed off the session id.
    const taintLabels = getKernelTaintSources(sessionId || "default");
    // Tainted-shell pre-gate: deny here, BEFORE ariEvaluate, so the kernel never
    // observes a taint+shell event and quarantines the run (which would also
    // block file writes for the rest of this op). Shell stays denied; editing
    // keeps working. See taintedShellBlockReason for the full rationale.
    const shellTaintBlock = taintedShellBlockReason(tc.name, taintLabels);
    if (shellTaintBlock) {
      return terminate(ctx, { rendered: "raw", content: `User hint: ${USER_HINTS.policy}\n${shellTaintBlock}`, allowed: false });
    }
    const ariResult = await ariEvaluate(tc.name, ARI_ACTION_MAP[tc.name] || "exec", args, taintLabels);
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
    if (WORKTREE_PATH_TOOLS.has(tc.name) && args.path) {
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
    // A blocked verify-shaped shell command (running the project's build/type-check
    // on source) gets accurate guidance instead of the generic "find a safer way"
    // recovery, which otherwise sends the model hunting a nonexistent executor. The
    // orchestrator build-verify gate covers it — see build-verify.ts.
    const selfVerify = blockedSelfVerifyGuidance(ctx.tc.name, ctx.args);
    ctx.allowed = false;
    ctx.result = {
      content: e.message,
      isError: true,
      status: "blocked",
      metadata: {
        layer: layerMap[e.stage],
        recovery: selfVerify?.recovery ?? e.recovery,
        userHint: selfVerify?.userHint ?? e.userHint,
      },
    };
    return BLOCK;
  }
  return CONTINUE;
}

// Cap on how many tool names a corrective lists inline. The op's surface is
// already tier-capped upstream (shrinkToolsForTier), so weak models naturally
// get a short list and strong models a longer one; this only guards the extreme.
const AVAILABLE_TOOLS_CAP = 50;

/**
 * Structured corrective for a hallucinated / mistyped tool name. A bare
 * "Unknown tool: X" leaves a weak model guessing — listing the exact names it
 * CAN call lets it self-correct in one turn instead of re-hallucinating. The
 * available set is the op's own (already-tier-capped) surface, so the message
 * self-scales to the model's tier. Pure + exported for unit testing.
 */
export function formatUnknownToolCorrection(toolName: string, available: string[]): string {
  const names = [...available].sort();
  const head = `Unknown tool "${toolName}" — not one of your available tools. `;
  const tail = "If you need a capability that isn't listed, call tool_search to load it.";
  if (names.length === 0) return head + tail;
  const list = names.length <= AVAILABLE_TOOLS_CAP
    ? names.join(", ")
    : names.slice(0, AVAILABLE_TOOLS_CAP).join(", ") + `, …(+${names.length - AVAILABLE_TOOLS_CAP} more)`;
  return head + `Use one of these exact names: ${list}. ` + tail;
}

function lookupTool(ctx: ToolCallContext): PhaseOutcome {
  const tool = ctx.toolMap.get(ctx.tc.name);
  if (!tool) {
    ctx.allowed = false;
    ctx.result = {
      content: formatUnknownToolCorrection(ctx.tc.name, [...ctx.toolMap.keys()]),
      isError: true,
      status: "error",
      metadata: { recovery: "Tool name typo or hallucinated name. Use one of the listed tool names exactly, or tool_search to load a capability that isn't listed." },
    };
    return BLOCK;
  }
  ctx.tool = tool;
  return CONTINUE;
}

/**
 * Collect per-field schema violations (required[], top-level type, enum) for a
 * tool call's args. Pure + exported so the structured-corrective contract — the
 * specific failing field, not a bare "invalid arguments" — is unit-testable.
 */
export function collectArgViolations(
  args: Record<string, unknown>,
  schema: { properties?: Record<string, { type?: string; enum?: unknown[] }>; required?: string[] } | undefined,
): string[] {
  const errs: string[] = [];
  if (!schema?.properties) return errs;
  for (const req of schema.required || []) {
    if (!(req in args)) errs.push(`missing required field "${req}"`);
  }
  for (const [key, propSchema] of Object.entries(schema.properties)) {
    if (!(key in args)) continue;
    const val = args[key];
    if (propSchema.type === "string" && typeof val !== "string") errs.push(`"${key}" must be a string (got ${typeof val})`);
    else if (propSchema.type === "number" && typeof val !== "number") errs.push(`"${key}" must be a number (got ${typeof val})`);
    else if (propSchema.type === "boolean" && typeof val !== "boolean") errs.push(`"${key}" must be a boolean (got ${typeof val})`);
    else if (propSchema.type === "array" && !Array.isArray(val)) errs.push(`"${key}" must be an array (got ${typeof val})`);
    if (propSchema.enum && !propSchema.enum.includes(val)) errs.push(`"${key}" must be one of [${propSchema.enum.map(v => JSON.stringify(v)).join(", ")}] (got ${JSON.stringify(val)})`);
  }
  return errs;
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

  const errs = collectArgViolations(ctx.args as Record<string, unknown>, schema);
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
  const circuit = checkCircuit(sessionId, tc.name, circuitArgsSig(tc.arguments));
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
  outcome = canaryEgressGate(ctx);
  if (outcome.kind !== "continue") return outcome;
  outcome = egressGuardGate(ctx);
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
