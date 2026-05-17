import type {
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions.js";
import type { ToolDefinition, ToolResult, ServerEvent } from "./types.js";
import { USER_HINTS } from "./types.js";
import { SecurityLayer } from "./security.js";
import type { ToolPolicy } from "./tool-policy.js";
import type { ThreatEngine } from "./threat-engine.js";
import type { RBACManager, Role } from "./rbac.js";
import { checkSessionPolicy } from "./session-policy.js";
import { ariEvaluate, isAriActive, shouldGateInKernel } from "./ari-kernel.js";
import { recordSensitiveRead, checkEgressTaint, isSensitivePath } from "./data-lineage.js";
import { compactIfNeeded, compactIfNeededWithLLM } from "./context-manager.js";
import { renderToolResultForModel } from "./tools/result-helpers.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { isPlanMode, READ_ONLY_TOOLS } from "./plan-tools.js";
import { getHookEngine } from "./hooks/hook-engine.js";
import { withRetry } from "./auto-retry.js";
import { getRetryContext } from "./retry-context.js";
import { checkCircuit, recordCircuitFailure, recordCircuitSuccess } from "./circuit-breaker.js";
import { recordToolCall as recordToolStat } from "./tool-tracker.js";
import { checkToolRateLimit, recordToolCall as recordRateLimit } from "./tool-rate-limiter.js";
import { getApprovalManager, toolNeedsApproval } from "./approval-manager.js";
import { logRetry } from "./retry-telemetry.js";
import { assertToolCallAllowed, ToolBlocked } from "./tools/pre-dispatch.js";

// Tools whose failures are usually transient (network, rate limit) and worth retrying.
const RETRYABLE_TOOLS = new Set([
  "http_request",
  "web_fetch",
  "web_search",
  "browser",
]);

// Tools whose failures are deterministic — never retry.
const NEVER_RETRY = new Set(["bash", "write", "edit", "agent_spawn", "delegate"]);

function isTransientError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("etimedout") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("enotfound") ||
    msg.includes("rate limit") ||
    msg.includes("429") ||
    msg.includes("503") ||
    msg.includes("504") ||
    msg.includes("network")
  );
}

/** Extended tool result that may include image data for vision analysis */
interface ToolResultWithImage extends ToolResult {
  _image?: { path: string; question: string; mime: string; b64: string };
}


// ── Result budgeting ──
// Large tool results get saved to disk with a preview returned to context.
// This prevents blowing up the conversation window with huge file reads or web fetches.

const RESULT_BUDGET_DIR = join(tmpdir(), "lax-results");
const DEFAULT_MAX_RESULT_SIZE = 50_000; // chars

function budgetResult(content: string, maxSize: number = DEFAULT_MAX_RESULT_SIZE): string {
  if (content.length <= maxSize) return content;
  try {
    mkdirSync(RESULT_BUDGET_DIR, { recursive: true });
    const hash = createHash("sha256").update(content).digest("hex").slice(0, 12);
    const path = join(RESULT_BUDGET_DIR, `${hash}.txt`);
    writeFileSync(path, content, "utf-8");
    const preview = content.slice(0, maxSize - 200);
    const lastNewline = preview.lastIndexOf("\n");
    const cleanPreview = lastNewline > 0 ? preview.slice(0, lastNewline) : preview;
    return `${cleanPreview}\n\n... [truncated — full result (${content.length} chars) saved to ${path}]`;
  } catch {
    return content.slice(0, maxSize) + `\n\n... [truncated at ${maxSize} chars]`;
  }
}

// ── Context compaction helper ──

export function checkAndCompact(
  messages: ChatCompletionMessageParam[],
  model: string,
  onEvent?: (event: ServerEvent) => void,
  force: boolean = false
): ChatCompletionMessageParam[] {
  const result = compactIfNeeded(messages, model, force);

  onEvent?.({
    type: "context_status",
    percentage: result.status.percentage,
    level: result.status.level,
    usedTokens: result.status.usedTokens,
    maxTokens: result.status.maxTokens,
    compacted: result.compacted,
  });

  return result.messages;
}

/**
 * Async variant — uses real LLM summarization instead of string truncation.
 * Falls back to the sync truncation path internally if the LLM call fails so
 * compaction never blocks. Prefer this over `checkAndCompact` in async paths.
 */
export async function checkAndCompactAsync(
  messages: ChatCompletionMessageParam[],
  model: string,
  onEvent?: (event: ServerEvent) => void,
  force: boolean = false,
): Promise<ChatCompletionMessageParam[]> {
  const result = await compactIfNeededWithLLM(messages, model, force);
  onEvent?.({
    type: "context_status",
    percentage: result.status.percentage,
    level: result.status.level,
    usedTokens: result.status.usedTokens,
    maxTokens: result.status.maxTokens,
    compacted: result.compacted,
  });
  return result.messages;
}

// ── Approval context ──

export function getRiskLevel(_toolName: string, _args: Record<string, unknown>, _security?: SecurityLayer): "low" | "medium" | "high" {
  return "low";
}

export function buildApprovalContext(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "bash":
      return `Run command: "${String(args.command || "").slice(0, 150)}"`;
    case "write":
      return `Create file: ${String(args.path || "").split(/[/\\]/).pop()} (${String(args.content || "").length} chars)`;
    case "edit":
      return `Edit file: ${String(args.path || "").split(/[/\\]/).pop()}`;
    case "read":
      return `Read file: ${String(args.path || "").split(/[/\\]/).pop()}`;
    case "browser": {
      const a = String(args.action || "");
      if (a === "navigate" || a === "new_tab") return `Open website: ${args.url || ""}`;
      if (a === "evaluate") return `Run script in browser: ${String(args.script || "").slice(0, 80)}`;
      return `Browser: ${a}`;
    }
    case "http_request":
      return `API call: ${args.method || "GET"} ${String(args.url || "").slice(0, 100)}`;
    case "web_fetch":
      return `Fetch webpage: ${String(args.url || "").slice(0, 100)}`;
    case "build_app":
      return `Build app: ${String(args.name || "")}`;
    default:
      return `${toolName}: ${JSON.stringify(args).slice(0, 80)}`;
  }
}

// ── Session-level duplicate detection ──
// When the model emits a tool call identical to one made earlier in the
// SAME session, skip re-execution and return the cached result with a hint.
// Catches the "I'm stuck mid-task, let me re-do the last thing I succeeded
// at" hallucination without hard-blocking legitimate repeats (the hint lets
// the model realize what it did and pivot).
function findPriorIdenticalResult(
  tc: { name: string; arguments: string },
  priorMessages: ChatCompletionMessageParam[],
): { result: string; turnIndex: number } | null {
  if (!priorMessages || priorMessages.length === 0) return null;
  // Scan back through prior assistant tool_calls for an exact match (name + args)
  for (let i = priorMessages.length - 1; i >= 0; i--) {
    const m = priorMessages[i];
    if (m.role !== "assistant") continue;
    const tcs = (m as unknown as { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }).tool_calls;
    if (!tcs || !Array.isArray(tcs)) continue;
    const match = tcs.find(t => t.function.name === tc.name && t.function.arguments === tc.arguments);
    if (!match) continue;
    // Find the paired tool result
    for (let j = i + 1; j < priorMessages.length; j++) {
      const r = priorMessages[j];
      if (r.role !== "tool") continue;
      const rid = (r as unknown as { tool_call_id?: string }).tool_call_id;
      if (rid === match.id && typeof r.content === "string") {
        return { result: r.content, turnIndex: i };
      }
    }
  }
  return null;
}

// ── Single tool execution (used by both serial and parallel paths) ──

async function executeSingleTool(
  tc: { id: string; name: string; arguments: string },
  toolMap: Map<string, ToolDefinition>,
  security: SecurityLayer,
  toolPolicy?: ToolPolicy,
  threatEngine?: ThreatEngine,
  rbac?: RBACManager,
  callerRole?: Role,
  sessionId?: string,
  onEvent?: (event: ServerEvent) => void,
  signal?: AbortSignal,
  priorMessages?: ChatCompletionMessageParam[],
): Promise<ChatCompletionMessageParam[]> {
  // Session-wide duplicate check — short-circuit before any execution.
  // request_secret is exempt: it emits a UI side-effect (secret_request SSE
  // event → modal). Re-running it on retry is the whole point when the user
  // missed the first prompt, and the tool itself short-circuits if the
  // secret already exists.
  const dup = (tc.name === "request_secret" || tc.name === "request_secrets") ? null : findPriorIdenticalResult(tc, priorMessages || []);
  if (dup) {
    const hint = `[REPEATED CALL — identical to a tool call made earlier this session. Returning the previous result without re-executing. If you need fresh data, change the arguments. Otherwise, focus on the user's current question.]\n\n${dup.result}`;
    onEvent?.({ type: "tool_end", toolName: tc.name, toolCallId: tc.id, result: hint, allowed: true });
    logRetry({ kind: "custom", sessionId, tool: tc.name, detail: { reason: "session-repeat", priorTurn: dup.turnIndex } });
    return [{ role: "tool", tool_call_id: tc.id, content: hint } as ChatCompletionMessageParam];
  }
  const msgs: ChatCompletionMessageParam[] = [];
  let args: Record<string, unknown>;
  try {
    const parsed = JSON.parse(tc.arguments);
    args = (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      ? parsed as Record<string, unknown>
      : { _raw: tc.arguments };
  } catch {
    // Weak models often emit malformed JSON (trailing commas, single quotes,
    // code fences). Attempt progressive relaxation before giving up.
    const { repairJson } = await import("./tool-arg-repair.js");
    const repair = repairJson(tc.arguments);
    if (repair.ok) {
      args = repair.value;
      logRetry({ kind: "tool-arg-invalid", sessionId, tool: tc.name, detail: { phase: "json-repair", fixes: repair.fixes } });
    } else {
      args = { _raw: tc.arguments };
    }
  }

  // Derive call context from session ID pattern (agent-* = delegated, cron-* = cron)
  const callContext = sessionId?.startsWith("agent-") ? "delegated" : sessionId?.startsWith("cron-") ? "cron" : "local";

  // Plan mode: block non-read-only tools (session-scoped)
  if (isPlanMode(sessionId) && !READ_ONLY_TOOLS.has(tc.name)) {
    const result = `User hint: ${USER_HINTS.planMode}\nBLOCKED: Plan mode is active. Only read-only tools are allowed. Use exit_plan_mode to restore full access.`;
    onEvent?.({ type: "tool_end", toolName: tc.name, toolCallId: tc.id, result, allowed: false });
    msgs.push({ role: "tool", tool_call_id: tc.id, content: result } as ChatCompletionMessageParam);
    return msgs;
  }
  // Protected files: block writes to core engine files that would brick the agent
  if (["write", "edit"].includes(tc.name) && args.path) {
    try {
      const { isProtectedFile } = await import("./config-loader.js");
      const check = isProtectedFile(String(args.path));
      if (check.protected) {
        const result = `User hint: ${USER_HINTS.secrets}\nBLOCKED: ${check.reason}. This file is part of the protected core — modifying it could break the agent engine. Edit config/ files instead to customize behavior.`;
        onEvent?.({ type: "tool_end", toolName: tc.name, toolCallId: tc.id, result, allowed: false });
        msgs.push({ role: "tool", tool_call_id: tc.id, content: result } as ChatCompletionMessageParam);
        return msgs;
      }
    } catch {}
  }

  // Inject session ID for tools that need session-scoped state
  const SESSION_SCOPED_TOOLS = new Set([
    "enter_plan_mode", "exit_plan_mode", "skill_run", "usage_report",
    "browser", "operation_start",
    "agent_spawn", "browser_capture_to_secret", "browser_fill_from_secret",
    "session_status", "request_secret", "request_secrets",
    "voice_visual",
    // Op tools — async submission needs to know the chat session so the
    // session bridge can route the completion notification back to it.
    // op_status / op_wait inherit the session for "ops you submitted" listing.
    "op_submit", "op_submit_async", "op_wait", "op_status",
    // Memory tools need session id to filter retrieval to current session
    // (default-deny cross-session bleed). search_past_sessions opts in
    // explicitly via crossSession=true; memory_search defaults to scoped.
    // memory_save tags daily-log entries so today_context can filter by
    // current session at read time.
    "memory_search", "search_past_sessions", "memory_save",
    // self_edit needs sessionId for the per-session live-call lock AND for
    // the intent/approval gates added in the safety pass — see self-edit-tool.ts.
    "self_edit",
    // build_app spawns a canonical op_app_build_*. Without sessionId the
    // op is created but never bound to the chat — session-bridge-observer
    // suppresses its bg_op_* events because getSessionForOp returns null,
    // so the AGENTS sidebar never sees the worker card.
    "build_app",
  ]);
  if (SESSION_SCOPED_TOOLS.has(tc.name)) {
    args._sessionId = sessionId || "default";
  }
  // Inject the chat's current project into agent_* tool calls so the
  // canonical scope (catalog filter + tool gate) flows from chat → spawn
  // automatically. The LLM doesn't have to remember; the runtime stamps
  // it in. If the LLM passes an explicit project_id, that wins.
  if ((tc.name === "agent_spawn" || tc.name === "agent_list" || tc.name === "agent_create") && sessionId) {
    if (!args.project_id) {
      const { getSessionProject } = await import("./session-project.js");
      const pid = getSessionProject(sessionId);
      if (pid) args.project_id = pid;
    }
  }
  // Inject conversational context for tools that need to sanity-check their
  // task against user intent (currently self_edit's intent gate). Last user
  // message + most recent assistant text are extracted from priorMessages
  // here so individual tools don't need to thread session-store access.
  if (tc.name === "self_edit" && Array.isArray(priorMessages)) {
    const reversed = [...priorMessages].reverse();
    const lastUser = reversed.find(m => m?.role === "user" && typeof m.content === "string");
    const lastAssistant = reversed.find(m => m?.role === "assistant" && typeof m.content === "string");
    if (lastUser?.content) args._lastUserMessage = String(lastUser.content);
    if (lastAssistant?.content) args._lastAssistantMessage = String(lastAssistant.content);
  }
  // Autopilot: re-route subprocess-style tools to the worktree CWD (NOT main repo)
  // and enforce the per-shift ceiling on self_edit invocations. The agent
  // thinks it's working inside the worktree — its bash/self_edit calls need
  // to run there too, otherwise commands like `npm run build` or `ls src/...`
  // either fail or touch the wrong tree.
  if (sessionId && (tc.name === "self_edit" || tc.name === "bash")) {
    try {
      const { isAutopilotSession, getAutopilotWorktree, trackSelfEditCall } = await import("./autopilot/registry.js");
      if (isAutopilotSession(sessionId)) {
        const wt = getAutopilotWorktree(sessionId);
        if (wt && !args._cwd) args._cwd = wt;
        if (tc.name === "self_edit") {
          const gate = trackSelfEditCall(sessionId);
          if (!gate.allowed) {
            const result = `User hint: ${USER_HINTS.retryExhausted}\nBLOCKED: self_edit ceiling reached for this autopilot run (${gate.count}/${gate.max}). Use direct edit/write/bash tools instead.`;
            onEvent?.({ type: "tool_end", toolName: tc.name, toolCallId: tc.id, result, allowed: false });
            msgs.push({ role: "tool", tool_call_id: tc.id, content: result } as ChatCompletionMessageParam);
            return msgs;
          }
        }
      }
    } catch { /* registry import failed — fail open, autopilot just not active */ }
  }
  // Inject onEvent for tools that need to stream events (e.g. request_secret,
  // browser emits browser_queued when waiting on the per-process mutex,
  // voice_visual emits a `visual` ServerEvent the browser morphs particles to,
  // build_app emits tool_progress lines from the spawned CLI's stdout so the
  // chat UI doesn't sit silent for 1-5 minutes during the subprocess run).
  if (
    tc.name === "request_secret" ||
    tc.name === "request_secrets" ||
    tc.name === "browser" ||
    tc.name === "voice_visual" ||
    tc.name === "build_app"
  ) {
    args._onEvent = onEvent;
  }

  const riskLevel = getRiskLevel(tc.name, args, security);
  const approvalContext = buildApprovalContext(tc.name, args);
  onEvent?.({ type: "tool_start", toolName: tc.name, toolCallId: tc.id, args, riskLevel, context: approvalContext, requiresApproval: riskLevel === "high" });

  // Layer -1: AriKernel. Only gated I/O tools (file/http/shell/database/
  // retrieval/secret-vault per TOOL_CLASS_MAP in ari-kernel.ts) hit the
  // kernel at this layer. Internal-class tools (orchestration, scheduled
  // missions, ari_* bridges that wrap kernel executors themselves) skip
  // the kernel here — their own routing already handles enforcement.
  // shouldGateInKernel is the single source of truth.
  if (isAriActive() && shouldGateInKernel(tc.name)) {
    // Action names must match HOST_CAPABILITY_MANIFEST in ari-kernel.ts.
    // Falling through to a default like "exec" for a non-shell tool means
    // lookupHostGrantId returns undefined → firewall.execute throws
    // "Capability token required" → ariRequired turns the throw into a
    // block. Map every gated tool to a manifest-valid action explicitly.
    const actionMap: Record<string, string> = {
      read: "read", write: "write", edit: "write",
      web_search: "get", web_fetch: "get", http_request: "get", browser: "get",
      bash: "exec",
      memory_search: "search",
      memory_save: "write",
      // secret-vault actions are overridden inside ariEvaluate by
      // secretVaultActionMap regardless of what we pass here; "capture"
      // is just a valid no-op default for the lookup.
      browser_capture_to_secret: "capture",
      browser_fill_from_secret: "fill",
      clipboard_write_from_secret: "clipboard",
    };
    const ariResult = await ariEvaluate(tc.name, actionMap[tc.name] || "exec", args);
    if (!ariResult.allowed) {
      const hint = ariResult.userHint ?? USER_HINTS.policy;
      const result = `User hint: ${hint}\n${ariResult.reason}`;
      onEvent?.({ type: "tool_end", toolName: tc.name, toolCallId: tc.id, result, allowed: false });
      msgs.push({ role: "tool", tool_call_id: tc.id, content: result } as ChatCompletionMessageParam);
      return msgs;
    }
  }

  // Layer 0: Session policy
  const policyBlock = checkSessionPolicy(sessionId || "default", tc.name);
  if (policyBlock) {
    const result = `User hint: ${USER_HINTS.policy}\n${policyBlock}`;
    onEvent?.({ type: "tool_end", toolName: tc.name, toolCallId: tc.id, result, allowed: false });
    msgs.push({ role: "tool", tool_call_id: tc.id, content: result } as ChatCompletionMessageParam);
    return msgs;
  }

  // Worktree enforcement: rewrite paths BEFORE security checks so security evaluates the actual path
  if (sessionId?.startsWith("agent-")) {
    try {
      const agentId = sessionId.slice(6);
      const { getWorktreePath } = await import("./agency/worktree.js");
      const wtPath = getWorktreePath(agentId);
      if (wtPath) {
        const pathTools = ["read", "write", "edit", "glob", "grep"];
        if (pathTools.includes(tc.name) && args.path) {
          const rawPath = String(args.path);
          const isAbsolute = rawPath.startsWith("/") || rawPath.includes(":");
          if (isAbsolute) {
            // Block absolute paths for search tools in worktree agents — prevents escape
            if (["glob", "grep"].includes(tc.name)) {
              const resolved = resolve(rawPath);
              if (relative(wtPath, resolved).startsWith("..")) {
                // Path escapes worktree — force it back to worktree root
                args.path = wtPath;
              }
            }
            // For read/write/edit, absolute paths go through security layer as-is
          } else {
            // Relative paths: prepend worktree root
            args.path = join(wtPath, rawPath);
          }
        }
        // No path arg: default search root to worktree for glob/grep
        if (["glob", "grep"].includes(tc.name) && !args.path) {
          args.path = wtPath;
        }
        if (tc.name === "bash") args._cwd = wtPath;
      }
    } catch { /* worktree module not available */ }
  }

  // Layers 1–3: Security → RBAC → ToolPolicy via the shared pre-dispatch chain
  // (session policy already ran inline above; approval gate fires later, after
  // circuit-breaker + rate-limit + hooks, to preserve original order).
  let allowed = true;
  let result: ToolResult;
  let preBlock: ToolBlocked | null = null;
  try {
    await assertToolCallAllowed(
      { id: tc.id, name: tc.name, args },
      {
        sessionId: sessionId || "default",
        callContext: callContext as "local" | "api" | "delegated" | "cron",
        skipSessionPolicy: true,
        security,
        rbac: rbac && callerRole ? { manager: rbac, role: callerRole } : undefined,
        toolPolicy,
      },
    );
  } catch (e) {
    if (e instanceof ToolBlocked) {
      preBlock = e;
      allowed = false;
    } else {
      throw e;
    }
  }

  if (preBlock) {
    const layerMap: Record<typeof preBlock.stage, string> = {
      "session-policy": "session-policy",
      "security": "security",
      "rbac": "rbac",
      "tool-policy": "tool-policy",
      "threat": "threat",
      "arikernel": "arikernel",
      "approval": "approval",
    };
    result = {
      content: preBlock.message,
      isError: true,
      status: "blocked",
      metadata: { layer: layerMap[preBlock.stage], recovery: preBlock.recovery, userHint: preBlock.userHint },
    };
  } else {
    // Data lineage egress check
    if (["http_request", "web_fetch"].includes(tc.name)) {
      const egressCheck = checkEgressTaint(sessionId || "default");
      if (egressCheck.blocked) {
        result = {
          content: `BLOCKED by data lineage: ${egressCheck.reason}`,
          isError: true,
          status: "blocked",
          metadata: { layer: "data-lineage", recovery: "Sensitive data was tainted earlier this session and may not egress. Either don't include the tainted data or end the session.", userHint: USER_HINTS.network },
        };
        onEvent?.({ type: "tool_end", toolName: tc.name, toolCallId: tc.id, result: result.content, allowed: false });
        msgs.push({ role: "tool", tool_call_id: tc.id, content: renderToolResultForModel(result) } as ChatCompletionMessageParam);
        return msgs;
      }
    }

    const tool = toolMap.get(tc.name);
    if (!tool) {
      result = {
        content: `Unknown tool: ${tc.name}`,
        isError: true,
        status: "error",
        metadata: { recovery: "Tool name typo or the tool isn't registered. Use tool_search to find the right name." },
      };
    } else {
      // Lightweight argument validation against the tool's JSON schema.
      // Weak models emit malformed args (missing required fields, wrong
      // types, invented enum values) that then blow up deep inside tool
      // execution with cryptic errors. Fail fast with a message the model
      // can correct on retry. Full JSON Schema validation is overkill —
      // just enforce required[] and type on top-level fields.
      const schema = tool.parameters as { type?: string; properties?: Record<string, { type?: string; enum?: unknown[] }>; required?: string[] } | undefined;
      // Attempt safe type coercion for scalar mismatches (e.g. "5" → 5, "true" → true)
      // before reporting validation errors. Silent in the happy path; logged when
      // repairs were applied.
      if (schema && typeof args === "object" && args && !("_raw" in args)) {
        try {
          const { coerceArgs } = await import("./tool-arg-repair.js");
          const result = coerceArgs(args as Record<string, unknown>, schema);
          if (result.fixes.length > 0) {
            args = result.coerced;
            logRetry({ kind: "tool-arg-invalid", sessionId, tool: tc.name, detail: { phase: "coerce", fixes: result.fixes } });
          }
        } catch {}
      }
      const argValidationErrors: string[] = [];
      if (schema && schema.properties && typeof args === "object" && args) {
        for (const req of schema.required || []) {
          if (!(req in args)) argValidationErrors.push(`missing required field "${req}"`);
        }
        for (const [key, propSchema] of Object.entries(schema.properties)) {
          if (!(key in args)) continue;
          const val = (args as Record<string, unknown>)[key];
          if (propSchema.type === "string" && typeof val !== "string") argValidationErrors.push(`"${key}" must be a string (got ${typeof val})`);
          else if (propSchema.type === "number" && typeof val !== "number") argValidationErrors.push(`"${key}" must be a number (got ${typeof val})`);
          else if (propSchema.type === "boolean" && typeof val !== "boolean") argValidationErrors.push(`"${key}" must be a boolean (got ${typeof val})`);
          else if (propSchema.type === "array" && !Array.isArray(val)) argValidationErrors.push(`"${key}" must be an array (got ${typeof val})`);
          if (propSchema.enum && !propSchema.enum.includes(val)) argValidationErrors.push(`"${key}" must be one of [${propSchema.enum.map(v => JSON.stringify(v)).join(", ")}] (got ${JSON.stringify(val)})`);
        }
      }
      if (argValidationErrors.length > 0) {
        result = {
          content: `Invalid arguments for ${tc.name}: ${argValidationErrors.join("; ")}. Fix and retry.`,
          isError: true,
          status: "error",
          metadata: { recovery: "Schema validation failed — fix the listed fields and retry. This is NOT a policy denial; the tool itself is available." },
        };
        onEvent?.({ type: "tool_end", toolName: tc.name, toolCallId: tc.id, result: result.content, allowed: false });
        msgs.push({ role: "tool", tool_call_id: tc.id, content: renderToolResultForModel(result) } as ChatCompletionMessageParam);
        return msgs;
      }

      // PreToolUse hook — can block execution
      const hookEngine = getHookEngine();
      if (hookEngine.hasHooks) {
        const preHook = await hookEngine.fire({ event: "PreToolUse", toolName: tc.name, toolArgs: args, sessionId, callContext });
        if (!preHook.continue) {
          result = {
            content: `BLOCKED by hook: ${preHook.reason || "PreToolUse hook returned false"}`,
            isError: true,
            status: "blocked",
            metadata: { layer: "hook", recovery: "A user-configured hook blocked this call. Check ~/.lax/hooks.json or proceed without the gated action.", userHint: USER_HINTS.policy },
          };
          onEvent?.({ type: "tool_end", toolName: tc.name, toolCallId: tc.id, result: result.content, allowed: false });
          msgs.push({ role: "tool", tool_call_id: tc.id, content: renderToolResultForModel(result) } as ChatCompletionMessageParam);
          return msgs;
        }
      }

      // Circuit breaker — refuse calls to tools that have repeatedly failed in this session
      const circuit = checkCircuit(sessionId, tc.name);
      if (!circuit.allowed) {
        result = {
          content: `BLOCKED by circuit breaker: ${circuit.reason}`,
          isError: true,
          status: "blocked",
          metadata: { layer: "circuit-breaker", recovery: "This tool has failed repeatedly in this session. Stop calling it and use an alternative — the breaker will reset after several successful unrelated calls.", userHint: circuit.userHint ?? USER_HINTS.retryExhausted },
        };
        onEvent?.({ type: "tool_end", toolName: tc.name, toolCallId: tc.id, result: result.content, allowed: false });
        msgs.push({ role: "tool", tool_call_id: tc.id, content: renderToolResultForModel(result) } as ChatCompletionMessageParam);
        return msgs;
      }

      // Per-tool rate limit (sliding window)
      const rate = checkToolRateLimit(tc.name, sessionId);
      if (!rate.allowed) {
        result = {
          content: `BLOCKED by rate limit: ${rate.reason}`,
          isError: true,
          status: "blocked",
          metadata: { layer: "rate-limit", recovery: "Per-tool rate limit hit. Wait or batch fewer calls; immediate retries will keep being denied.", userHint: rate.userHint ?? USER_HINTS.retryExhausted },
        };
        onEvent?.({ type: "tool_end", toolName: tc.name, toolCallId: tc.id, result: result.content, allowed: false });
        msgs.push({ role: "tool", tool_call_id: tc.id, content: renderToolResultForModel(result) } as ChatCompletionMessageParam);
        return msgs;
      }

      // Inject progress callback for tools that support streaming updates
      const progressFn = (message: string) => {
        onEvent?.({ type: "tool_progress", toolName: tc.name, toolCallId: tc.id, message });
      };
      args._onProgress = progressFn;

      // HumanLayer-style approval gate for dangerous tools. Skipped for cron + delegated
      // agents (no human watching) and for the Ari-whitelisted internal tools.
      if (toolNeedsApproval(tc.name) && callContext === "local" && onEvent) {
        const approved = await getApprovalManager().requestApproval({
          toolName: tc.name,
          toolCallId: tc.id,
          sessionId: sessionId || "default",
          context: approvalContext,
          args,
          emit: onEvent,
        });
        if (!approved) {
          result = {
            content: `BLOCKED by user: declined approval for ${tc.name}`,
            isError: true,
            status: "blocked",
            metadata: { layer: "approval", userHint: USER_HINTS.policy },
          };
          onEvent({ type: "tool_end", toolName: tc.name, toolCallId: tc.id, result: result.content, allowed: false });
          msgs.push({ role: "tool", tool_call_id: tc.id, content: renderToolResultForModel(result) } as ChatCompletionMessageParam);
          return msgs;
        }
      }

      // (worktree rewrite moved before security evaluation)

      const startedAt = Date.now();
      const shouldRetry = RETRYABLE_TOOLS.has(tc.name) && !NEVER_RETRY.has(tc.name);

      try {
        if (shouldRetry) {
          result = await withRetry(() => tool.execute(args, signal), {
            maxRetries: 2,
            baseDelayMs: 500,
            maxDelayMs: 4000,
            shouldRetry: (err) => isTransientError(err),
            ctx: getRetryContext(sessionId),
            layer: "L1-tool",
          });
        } else {
          result = await tool.execute(args, signal);
        }
        if (tc.name === "read" && isSensitivePath(String(args.path || ""))) {
          recordSensitiveRead(sessionId || "default", "sensitive_file", String(args.path));
        }
      } catch (e) {
        result = { content: `Tool error: ${(e as Error).message}`, isError: true };
      }

      // Record stats + breaker state + rate-limit consumption
      const durationMs = Date.now() - startedAt;
      const succeeded = !result.isError;
      try { recordToolStat(tc.name, sessionId || "default", succeeded, durationMs, result.isError ? result.content?.slice(0, 200) : undefined); } catch { /* tracker should never break the call */ }
      try { recordRateLimit(tc.name, sessionId); } catch { /* same */ }
      if (succeeded) {
        recordCircuitSuccess(sessionId, tc.name);
      } else {
        recordCircuitFailure(sessionId, tc.name, typeof result.content === "string" ? result.content : undefined);
      }
    }
  }

  // Layer 4: ThreatEngine
  if (threatEngine) {
    const threat = threatEngine.evaluateToolResult(tc.name, args, result.content, allowed);
    if (threat.blocked) {
      // Enriched block message tells the model how the USER can grant
      // consent if this is a legitimate workflow. Without this, the model
      // sees "BLOCKED" and has no recovery channel — observed live as the
      // model collapsing into "Tool call: ..." narration (2026-05-13).
      // The /approve handler lives in routes/chat/run-chat-turn.ts and
      // grants 30-min session-level consent via consent-store.ts.
      result = {
        content:
          `BLOCKED by threat engine: ${threat.reason}\n\n` +
          `If this is a legitimate workflow (user explicitly shared data with you and named the destination), ` +
          `tell the user to type:\n` +
          `  /approve <one-line description>\n` +
          `That grants 30 minutes of consent for this session. Retry the tool after they approve.\n` +
          `Do NOT retry without /approve — you will hit the same block.`,
        isError: true,
        status: "blocked",
        metadata: { layer: "threat", userHint: USER_HINTS.threatConsent },
      };
    }
    if (threatEngine.isRestricted() && ["http_request", "web_fetch", "browser"].includes(tc.name)) {
      let isOwnApp = false;
      if (tc.name === "browser") {
        const urlArg = String(args.url || "");
        const appPort = process.env.LAX_PORT ?? process.env.SAX_PORT ?? "7007";
        if (new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${appPort}`, "i").test(urlArg)) {
          isOwnApp = true;
        }
      }
      if (!isOwnApp) {
        result = {
          content: `BLOCKED: Session threat level elevated. External tool calls restricted.`,
          isError: true,
          status: "blocked",
          metadata: { layer: "threat", userHint: USER_HINTS.network },
        };
      }
    }
  }

  // Result budgeting
  if (!result.isError) {
    result = { ...result, content: budgetResult(result.content) };
  }

  // PostToolUse / PostToolUseFailure hooks — fire AFTER threat engine + budgeting
  // Hooks only see the final (sanitized, budgeted) result, not raw output
  const hookEngine = getHookEngine();
  if (hookEngine.hasHooks && allowed) {
    const hookEvent = result.isError ? "PostToolUseFailure" : "PostToolUse";
    hookEngine.fireDetached({
      event: hookEvent, toolName: tc.name, toolArgs: args,
      ...(result.isError ? { toolError: result.content } : { toolResult: result.content?.slice(0, 2000) }),
      sessionId, callContext,
    });
  }

  onEvent?.({ type: "tool_end", toolName: tc.name, toolCallId: tc.id, result: result.content, allowed });

  // Harvest a structured chip if the tool attached one to metadata. Stays
  // in the onEvent channel — the model's tool_result message body
  // (`renderToolResultForModel(result)` below) is built from `result.content`
  // only and never sees the chip. See ToolChip docstring in src/types.ts
  // for why op ids must NOT round-trip through the model's text channel.
  const chip = (result.metadata as { chip?: import("./types.js").ToolChip } | undefined)?.chip;
  if (chip && onEvent) {
    onEvent({ type: "tool_chip", toolCallId: tc.id, chip });
  }

  const imageData = (result as ToolResultWithImage)._image;
  if (imageData) {
    msgs.push({ role: "tool", tool_call_id: tc.id, content: `Image loaded: ${imageData.path}\nQuestion: ${imageData.question}` } as ChatCompletionMessageParam);
    msgs.push({ role: "user", content: [
      { type: "text", text: `[Image from ${imageData.path}] ${imageData.question}` },
      { type: "image_url", image_url: { url: `data:${imageData.mime};base64,${imageData.b64}`, detail: "auto" } },
    ]} as ChatCompletionMessageParam);
  } else {
    msgs.push({ role: "tool", tool_call_id: tc.id, content: renderToolResultForModel(result) });
  }

  return msgs;
}

// ── Unified single-call dispatcher (ToolResult-returning) ──
// Public alias around executeSingleTool for callers that want a single
// dispatcher with a clean ToolResult contract (input ToolCall, output
// ToolResult). Closes F2 part 2: any code path that previously routed
// through a parallel dispatcher (the AriKernel `ToolExecutor.execute` path,
// the old `ExecutorRegistry.get`-then-execute pattern) calls this instead.
// Capability tokens / taint labels surface as fields on
// ToolResult.metadata.arikernel rather than a separate execution stack.

export interface UnifiedDispatchCtx {
  toolMap: Map<string, ToolDefinition>;
  security: SecurityLayer;
  toolPolicy?: ToolPolicy;
  threatEngine?: ThreatEngine;
  rbac?: RBACManager;
  callerRole?: Role;
  sessionId?: string;
  onEvent?: (event: ServerEvent) => void;
  signal?: AbortSignal;
  priorMessages?: ChatCompletionMessageParam[];
}

/**
 * Single dispatch entry — input ToolCall, output ToolResult. Internally
 * routes through executeSingleTool so the gate chain, retries, hooks,
 * circuit-breaker, rate limit, approval, and budgeting all run exactly
 * once per dispatch.
 */
export async function dispatchSingleToolCall(
  call: { id: string; name: string; arguments?: string; args?: Record<string, unknown> },
  ctx: UnifiedDispatchCtx,
): Promise<ToolResult> {
  const argsStr = call.arguments ?? JSON.stringify(call.args ?? {});
  const msgs = await executeSingleTool(
    { id: call.id, name: call.name, arguments: argsStr },
    ctx.toolMap,
    ctx.security,
    ctx.toolPolicy,
    ctx.threatEngine,
    ctx.rbac,
    ctx.callerRole,
    ctx.sessionId,
    ctx.onEvent,
    ctx.signal,
    ctx.priorMessages,
  );
  const last = msgs[msgs.length - 1];
  const content = typeof last?.content === "string" ? last.content : "";
  return { content, isError: false, status: "ok" };
}

// ── Security-layered tool execution (orchestrator) ──

export async function executeToolCalls(
  toolCalls: Array<{ id: string; name: string; arguments: string }>,
  toolMap: Map<string, ToolDefinition>,
  security: SecurityLayer,
  toolPolicy?: ToolPolicy,
  threatEngine?: ThreatEngine,
  rbac?: RBACManager,
  callerRole?: Role,
  sessionId?: string,
  onEvent?: (event: ServerEvent) => void,
  signal?: AbortSignal,
  priorMessages?: ChatCompletionMessageParam[],
): Promise<ChatCompletionMessageParam[]> {
  const results: ChatCompletionMessageParam[] = [];

  // Execute tools in order, batching adjacent concurrent-safe / read-only tools together.
  // Read-only tools are implicitly safe to parallelize (they never mutate state).
  // This preserves the original call order while parallelizing where safe.
  const isParallelSafe = (t: ToolDefinition | undefined): boolean => {
    if (!t) return false;
    return Boolean(t.readOnly) || Boolean(t.concurrencySafe);
  };

  let i = 0;
  while (i < toolCalls.length) {
    const tc = toolCalls[i];
    const tool = toolMap.get(tc.name);
    const isConcurrent = isParallelSafe(tool);

    if (isConcurrent) {
      // Collect adjacent parallel-safe tools into a batch
      const batch: typeof toolCalls = [tc];
      while (i + 1 < toolCalls.length) {
        const next = toolCalls[i + 1];
        const nextTool = toolMap.get(next.name);
        if (isParallelSafe(nextTool)) {
          batch.push(next);
          i++;
        } else break;
      }
      if (batch.length > 1) {
        const parallelResults = await Promise.all(
          batch.map((b) => executeSingleTool(b, toolMap, security, toolPolicy, threatEngine, rbac, callerRole, sessionId, onEvent, signal, priorMessages))
        );
        results.push(...parallelResults.flat());
      } else {
        const msgs = await executeSingleTool(batch[0], toolMap, security, toolPolicy, threatEngine, rbac, callerRole, sessionId, onEvent, signal, priorMessages);
        results.push(...msgs);
      }
    } else {
      const msgs = await executeSingleTool(tc, toolMap, security, toolPolicy, threatEngine, rbac, callerRole, sessionId, onEvent, signal, priorMessages);
      results.push(...msgs);
    }
    i++;
  }

  return results;
}
