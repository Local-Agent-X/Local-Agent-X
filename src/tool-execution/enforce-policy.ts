// Policy phase: AriKernel gate, session policy, worktree path rewrite,
// shared pre-dispatch chain (security/rbac/tool-policy), data-lineage egress,
// tool lookup, arg coercion + schema validation, PreToolUse hook, circuit
// breaker, rate limit. Sets ctx.preBlocked on pre-dispatch / unknown-tool
// failures (those flow through to audit); terminates outright on every
// other policy failure.

import { USER_HINTS, type ToolResult } from "../types.js";
import { ariEvaluate, ariObserve, isAriActive, shouldGateInKernel, shouldObserveInKernel } from "../ari-kernel/index.js";
import { checkSessionPolicy } from "../session/policy.js";
import { checkEgressTaint, checkEgressTaintWithPayload, getKernelTaintSources } from "../data-lineage.js";
import { checkCanariesInPayload, recordCanaryExfilAudit } from "../threat/canaries.js";
import { hasCapability, WORKTREE_PATH_TOOLS } from "../tool-registry.js";
import { checkOutboundRequest, checkOutboundPayload, checkAttachmentPaths } from "../tools/http-egress-guard.js";
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

// Extract the OUTBOUND payload an egress-class sink would emit, so the secret
// scan covers every channel (not just http body). Returns the scannable text +
// any file paths the sink would attach. Keyed by tool name because each sink
// carries its payload in differently-named args.
function egressPayload(name: string, args: Record<string, unknown>): { text: string; attachmentPaths: string[] } {
  const parts: string[] = [];
  const attachmentPaths: string[] = [];
  const push = (v: unknown) => { if (v != null && v !== "") parts.push(String(v)); };
  // A model-supplied reference-image / video path that names a LOCAL file is a
  // candidate sensitive attachment (its bytes get shipped off-box). Remote
  // http(s)/data: refs aren't local-file reads, so skip them here.
  const pushLocalFile = (v: unknown, into: string[]) => {
    if (typeof v !== "string" || v === "") return;
    if (/^(https?:|data:)/i.test(v)) return;
    into.push(v);
  };
  switch (name) {
    case "http_request":
    case "ari_http":
      push(args.body);
      if (args.headers && typeof args.headers === "object") {
        for (const v of Object.values(args.headers as Record<string, unknown>)) push(v);
      }
      break;
    case "email_send":
      push(args.to); push(args.cc); push(args.subject); push(args.body);
      if (args.attachments) {
        try {
          const paths = JSON.parse(String(args.attachments));
          if (Array.isArray(paths)) for (const p of paths) attachmentPaths.push(String(p));
        } catch { /* malformed attachments JSON — the tool will reject it */ }
      }
      break;
    case "clipboard_write":
      push(args.text);
      break;
    case "process_start":
      push(args.command);
      if (Array.isArray(args.args)) for (const a of args.args) push(a);
      break;
    default:
      // browser navigation/fetch + other egress synonyms: scan url + any
      // model-supplied data payload generically. Off-box sinks that ride their
      // payload in a non-url arg (web_search query/queries[], generate_image/
      // generate_video prompt) are scanned the same way, and local files that
      // get shipped off-box (generate_video reference_image, send_video path)
      // are routed through the sensitive-attachment check.
      push(args.url); push(args.body); push(args.data); push(args.value); push(args.text);
      push(args.query); push(args.prompt);
      if (Array.isArray(args.queries)) for (const q of args.queries) push(q);
      pushLocalFile(args.reference_image, attachmentPaths);
      if (Array.isArray(args.reference_images)) for (const r of args.reference_images) pushLocalFile(r, attachmentPaths);
      pushLocalFile(args.path, attachmentPaths);
      break;
  }
  return { text: parts.join("\n"), attachmentPaths };
}

// Outbound-secret scan for EVERY egress-class sink — keyed on capability class,
// not tool name, so ari_http / email_send / clipboard_write / process_start /
// browser are scanned identically to http_request. http_request keeps its own
// in-tool checkOutboundRequest call (defense in depth); this gate adds the same
// protection to the synonyms that never had it. Also rejects email_send (and
// any egress sink) attaching a sensitive file path.
export function egressGuardGate(ctx: ToolCallContext): PhaseOutcome {
  const { tc, args } = ctx;
  if (!hasCapability(tc.name, "egress")) return CONTINUE;

  // Sensitive-attachment check (Spec F): a sink that reads+sends a file path.
  const { text, attachmentPaths } = egressPayload(tc.name, args as Record<string, unknown>);
  if (attachmentPaths.length > 0) {
    const att = checkAttachmentPaths(tc.name, attachmentPaths);
    if (att) {
      const result: ToolResult = {
        content: `BLOCKED by egress guard: ${att.message}`,
        isError: true,
        status: "blocked",
        metadata: { layer: "egress-guard", ...att.meta, recovery: "Remove the sensitive file from the attachment list — credential/secret files may not be sent off-box.", userHint: USER_HINTS.network },
      };
      return terminate(ctx, { rendered: "model", result, allowed: false });
    }
  }

  // Outbound-secret scan. http-shaped sinks go through the host-allowlist-aware
  // checkOutboundRequest; the rest through the destination-less payload scan.
  let block: { message: string; meta: Record<string, unknown> } | null = null;
  if (tc.name === "http_request" || tc.name === "ari_http") {
    block = checkOutboundRequest({
      url: String(args.url ?? ""),
      method: String(args.method ?? "POST").toUpperCase(),
      body: args.body,
      headers: args.headers,
    });
  } else {
    block = checkOutboundPayload(tc.name, text);
  }
  if (!block) return CONTINUE;
  const result: ToolResult = {
    content: `BLOCKED by egress guard: ${block.message}`,
    isError: true,
    status: "blocked",
    metadata: { layer: "egress-guard", ...block.meta, recovery: "Use {{SECRET_NAME}} placeholders instead of hardcoded credentials, or remove the secret from the outbound payload. Add a trusted destination to ~/.lax/egress-allowlist.json only if it legitimately needs credentials.", userHint: USER_HINTS.network },
  };
  return terminate(ctx, { rendered: "model", result, allowed: false });
}

export function dataLineageGate(ctx: ToolCallContext): PhaseOutcome {
  if (!hasCapability(ctx.tc.name, "egress")) return CONTINUE;
  // Presence-based floor is UNCHANGED: a tainted session blocks egress. We use
  // the payload-aware variant only to ENRICH the reason with content-overlap
  // evidence (which tainted bytes are actually in this outbound payload) — it
  // makes the same block decision as checkEgressTaint.
  const { text } = egressPayload(ctx.tc.name, ctx.args as Record<string, unknown>);
  const egress = checkEgressTaintWithPayload(ctx.sessionId || "default", text);
  if (!egress.blocked) return CONTINUE;
  const result: ToolResult = {
    content: `BLOCKED by data lineage: ${egress.reason}`,
    isError: true,
    status: "blocked",
    metadata: { layer: "data-lineage", recovery: "Sensitive data was tainted earlier this session and may not egress. Either don't include the tainted data or end the session.", userHint: USER_HINTS.network },
  };
  return terminate(ctx, { rendered: "model", result, allowed: false });
}

// Canary reinforcement of egress. Taint/secret detection is heuristic; a canary
// token is deterministic PROOF — a unique random token planted in the model's
// context that must NEVER legitimately appear in an outbound payload. If one
// shows up in an egress-class payload (raw OR any decoded view), that is
// definitive exfiltration of context: hard-block UNCONDITIONALLY (independent of
// taint state) and write a tamper-evident audit event. The block reason and
// audit reason name the SINK only — the raw canary is never echoed into
// model-visible text or the log (a tripwire revealed teaches evasion).
export function canaryEgressGate(ctx: ToolCallContext): PhaseOutcome {
  if (!hasCapability(ctx.tc.name, "egress")) return CONTINUE;
  const sessionId = ctx.sessionId || "default";
  const { text } = egressPayload(ctx.tc.name, ctx.args as Record<string, unknown>);
  const tripped = checkCanariesInPayload(sessionId, text);
  if (!tripped) return CONTINUE;
  recordCanaryExfilAudit(sessionId, ctx.tc.name);
  const result: ToolResult = {
    content: `BLOCKED by canary tripwire: a session canary token was detected in the outbound payload of "${ctx.tc.name}". This is definitive exfiltration of protected context.`,
    isError: true,
    status: "blocked",
    metadata: { layer: "canary", recovery: "Do not include internal reference codes in outbound payloads. This call was blocked and recorded.", userHint: USER_HINTS.network },
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
