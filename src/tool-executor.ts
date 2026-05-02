import type {
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions.js";
import type { ToolDefinition, ToolResult, ServerEvent } from "./types.js";
import { SecurityLayer } from "./security.js";
import type { ToolPolicy } from "./tool-policy.js";
import type { ThreatEngine } from "./threat-engine.js";
import type { RBACManager, Role } from "./rbac.js";
import { checkSessionPolicy } from "./session-policy.js";
import { ariEvaluate, isAriActive } from "./ari-kernel.js";
import { recordSensitiveRead, checkEgressTaint, isSensitivePath } from "./data-lineage.js";
import { compactIfNeeded } from "./context-manager.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { isPlanMode, READ_ONLY_TOOLS } from "./plan-tools.js";
import { getHookEngine } from "./hooks/hook-engine.js";
import { withRetry } from "./auto-retry.js";
import { checkCircuit, recordCircuitFailure, recordCircuitSuccess } from "./circuit-breaker.js";
import { recordToolCall as recordToolStat } from "./tool-tracker.js";
import { checkToolRateLimit, recordToolCall as recordRateLimit } from "./tool-rate-limiter.js";
import { getApprovalManager, toolNeedsApproval } from "./approval-manager.js";
import { logRetry } from "./retry-telemetry.js";

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

/** ChatCompletionMessageParam with tool_calls visible (OpenAI types hide this on some message subtypes) */
interface AssistantMessageWithToolCalls {
  role: "assistant";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
}

/** Tool message with tool_call_id */
interface ToolMessageParam {
  role: "tool";
  tool_call_id: string;
  content: string;
}

/** User message with vision content parts */
interface VisionUserMessage {
  role: "user";
  content: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string; detail?: string } }
  >;
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
  // Session-wide duplicate check — short-circuit before any execution
  const dup = findPriorIdenticalResult(tc, priorMessages || []);
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
    const result = `BLOCKED: Plan mode is active. Only read-only tools are allowed. Use exit_plan_mode to restore full access.`;
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
        const result = `BLOCKED: ${check.reason}. This file is part of the protected core — modifying it could break the agent engine. Edit config/ files instead to customize behavior.`;
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
    "session_status", "request_secret",
    "voice_visual",
    // Op tools — async submission needs to know the chat session so the
    // session bridge can route the completion notification back to it.
    // op_status / op_wait inherit the session for "ops you submitted" listing.
    "op_submit", "op_submit_async", "op_wait", "op_status",
  ]);
  if (SESSION_SCOPED_TOOLS.has(tc.name)) {
    args._sessionId = sessionId || "default";
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
            const result = `BLOCKED: self_edit ceiling reached for this autopilot run (${gate.count}/${gate.max}). Use direct edit/write/bash tools instead.`;
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
  // voice_visual emits a `visual` ServerEvent the browser morphs particles to).
  if (tc.name === "request_secret" || tc.name === "browser" || tc.name === "voice_visual") {
    args._onEvent = onEvent;
  }

  const riskLevel = getRiskLevel(tc.name, args, security);
  const approvalContext = buildApprovalContext(tc.name, args);
  onEvent?.({ type: "tool_start", toolName: tc.name, toolCallId: tc.id, args, riskLevel, context: approvalContext, requiresApproval: riskLevel === "high" });

  // Layer -1: AriKernel
  const isInternalTool = tc.name.startsWith("agent_") || tc.name.startsWith("swarm_") ||
    tc.name.startsWith("mission_") ||
    ["delegate", "generate_image", "generate_video", "camera_capture", "screen_capture", "ocr",
     "memory_search", "memory_save", "playbook_list", "playbook_get"].includes(tc.name);
  if (isAriActive()) {
    const actionMap: Record<string, string> = { read: "read", write: "write", edit: "write", bash: "exec" };
    const ariResult = await ariEvaluate(tc.name, actionMap[tc.name] || "exec", args);
    if (!ariResult.allowed && !isInternalTool) {
      onEvent?.({ type: "tool_end", toolName: tc.name, toolCallId: tc.id, result: ariResult.reason, allowed: false });
      msgs.push({ role: "tool", tool_call_id: tc.id, content: ariResult.reason } as ChatCompletionMessageParam);
      return msgs;
    }
  }

  // Layer 0: Session policy
  const policyBlock = checkSessionPolicy(sessionId || "default", tc.name);
  if (policyBlock) {
    onEvent?.({ type: "tool_end", toolName: tc.name, toolCallId: tc.id, result: policyBlock, allowed: false });
    msgs.push({ role: "tool", tool_call_id: tc.id, content: policyBlock } as ChatCompletionMessageParam);
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

  // Layer 1: SecurityLayer (now sees rewritten worktree paths)
  const secDecision = security.evaluate({ toolName: tc.name, args, sessionId: sessionId || "default", callContext: callContext as "local" | "api" | "delegated" | "cron" });

  // Layer 2: RBAC
  let rbacBlocked = false, rbacReason = "";
  if (rbac && callerRole) {
    const d = rbac.checkTool(callerRole, tc.name);
    if (!d.allowed) { rbacBlocked = true; rbacReason = d.reason; }
  }

  // Layer 3: ToolPolicy
  let policyBlocked = false, policyReason = "";
  if (secDecision.allowed && !rbacBlocked && toolPolicy) {
    const d = toolPolicy.evaluate(tc.name, args, sessionId || "default");
    if (!d.allowed) { policyBlocked = true; policyReason = d.reason; }
  }

  const allowed = secDecision.allowed && !rbacBlocked && !policyBlocked;
  let result: ToolResult;

  if (!secDecision.allowed) {
    result = { content: `BLOCKED by security: ${secDecision.reason}`, isError: true };
  } else if (rbacBlocked) {
    result = { content: `BLOCKED by RBAC: ${rbacReason}`, isError: true };
  } else if (policyBlocked) {
    result = { content: `BLOCKED by policy: ${policyReason}`, isError: true };
  } else {
    // Data lineage egress check
    if (["http_request", "web_fetch"].includes(tc.name)) {
      const egressCheck = checkEgressTaint(sessionId || "default");
      if (egressCheck.blocked) {
        result = { content: `BLOCKED by data lineage: ${egressCheck.reason}`, isError: true };
        onEvent?.({ type: "tool_end", toolName: tc.name, toolCallId: tc.id, result: result.content, allowed: false });
        msgs.push({ role: "tool", tool_call_id: tc.id, content: result.content } as ChatCompletionMessageParam);
        return msgs;
      }
    }

    const tool = toolMap.get(tc.name);
    if (!tool) {
      result = { content: `Unknown tool: ${tc.name}`, isError: true };
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
        result = { content: `Invalid arguments for ${tc.name}: ${argValidationErrors.join("; ")}. Fix and retry.`, isError: true };
        onEvent?.({ type: "tool_end", toolName: tc.name, toolCallId: tc.id, result: result.content, allowed: false });
        msgs.push({ role: "tool", tool_call_id: tc.id, content: result.content } as ChatCompletionMessageParam);
        return msgs;
      }

      // PreToolUse hook — can block execution
      const hookEngine = getHookEngine();
      if (hookEngine.hasHooks) {
        const preHook = await hookEngine.fire({ event: "PreToolUse", toolName: tc.name, toolArgs: args, sessionId, callContext });
        if (!preHook.continue) {
          result = { content: `BLOCKED by hook: ${preHook.reason || "PreToolUse hook returned false"}`, isError: true };
          onEvent?.({ type: "tool_end", toolName: tc.name, toolCallId: tc.id, result: result.content, allowed: false });
          msgs.push({ role: "tool", tool_call_id: tc.id, content: result.content } as ChatCompletionMessageParam);
          return msgs;
        }
      }

      // Circuit breaker — refuse calls to tools that have repeatedly failed in this session
      const circuit = checkCircuit(sessionId, tc.name);
      if (!circuit.allowed) {
        result = { content: `BLOCKED by circuit breaker: ${circuit.reason}`, isError: true };
        onEvent?.({ type: "tool_end", toolName: tc.name, toolCallId: tc.id, result: result.content, allowed: false });
        msgs.push({ role: "tool", tool_call_id: tc.id, content: result.content } as ChatCompletionMessageParam);
        return msgs;
      }

      // Per-tool rate limit (sliding window)
      const rate = checkToolRateLimit(tc.name, sessionId);
      if (!rate.allowed) {
        result = { content: `BLOCKED by rate limit: ${rate.reason}`, isError: true };
        onEvent?.({ type: "tool_end", toolName: tc.name, toolCallId: tc.id, result: result.content, allowed: false });
        msgs.push({ role: "tool", tool_call_id: tc.id, content: result.content } as ChatCompletionMessageParam);
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
          result = { content: `BLOCKED by user: declined approval for ${tc.name}`, isError: true };
          onEvent({ type: "tool_end", toolName: tc.name, toolCallId: tc.id, result: result.content, allowed: false });
          msgs.push({ role: "tool", tool_call_id: tc.id, content: result.content } as ChatCompletionMessageParam);
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
        recordCircuitFailure(sessionId, tc.name);
      }
    }
  }

  // Layer 4: ThreatEngine
  if (threatEngine) {
    const threat = threatEngine.evaluateToolResult(tc.name, args, result.content, allowed);
    if (threat.blocked) {
      result = { content: `BLOCKED by threat engine: ${threat.reason}`, isError: true };
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
        result = { content: `BLOCKED: Session threat level elevated. External tool calls restricted.`, isError: true };
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

  const imageData = (result as ToolResultWithImage)._image;
  if (imageData) {
    msgs.push({ role: "tool", tool_call_id: tc.id, content: `Image loaded: ${imageData.path}\nQuestion: ${imageData.question}` } as ChatCompletionMessageParam);
    msgs.push({ role: "user", content: [
      { type: "text", text: `[Image from ${imageData.path}] ${imageData.question}` },
      { type: "image_url", image_url: { url: `data:${imageData.mime};base64,${imageData.b64}`, detail: "auto" } },
    ]} as ChatCompletionMessageParam);
  } else {
    msgs.push({ role: "tool", tool_call_id: tc.id, content: result.content });
  }

  return msgs;
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
