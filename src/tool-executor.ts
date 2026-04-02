import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
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
import { join } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { isPlanMode, READ_ONLY_TOOLS } from "./plan-tools.js";
import { getHookEngine } from "./hooks/hook-engine.js";

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

const RESULT_BUDGET_DIR = join(tmpdir(), "sax-results");
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

// ── OpenAI tool format conversion ──

export function toolsToOpenAI(tools: ToolDefinition[]): ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
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
  signal?: AbortSignal
): Promise<ChatCompletionMessageParam[]> {
  const msgs: ChatCompletionMessageParam[] = [];
  let args: Record<string, unknown>;
  try { args = JSON.parse(tc.arguments); }
  catch { args = { _raw: tc.arguments }; }

  // Derive call context from session ID pattern (agent-* = delegated, cron-* = cron)
  const callContext = sessionId?.startsWith("agent-") ? "delegated" : sessionId?.startsWith("cron-") ? "cron" : "local";

  // Plan mode: block non-read-only tools (session-scoped)
  if (isPlanMode(sessionId) && !READ_ONLY_TOOLS.has(tc.name)) {
    const result = `BLOCKED: Plan mode is active. Only read-only tools are allowed. Use exit_plan_mode to restore full access.`;
    onEvent?.({ type: "tool_end", toolName: tc.name, toolCallId: tc.id, result, allowed: false });
    msgs.push({ role: "tool", tool_call_id: tc.id, content: result } as ChatCompletionMessageParam);
    return msgs;
  }
  // Inject session ID for tools that need session-scoped state
  if (tc.name === "enter_plan_mode" || tc.name === "exit_plan_mode" || tc.name === "skill_run") {
    args._sessionId = sessionId || "default";
  }

  const riskLevel = getRiskLevel(tc.name, args, security);
  const approvalContext = buildApprovalContext(tc.name, args);
  onEvent?.({ type: "tool_start", toolName: tc.name, toolCallId: tc.id, args, riskLevel, context: approvalContext, requiresApproval: riskLevel === "high" });

  // Layer -1: AriKernel
  const isInternalTool = tc.name.startsWith("agent_") || tc.name.startsWith("swarm_") ||
    tc.name.startsWith("mission_") || tc.name.startsWith("cron_") ||
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
              const { resolve, relative } = require("node:path") as typeof import("node:path");
              const resolved = resolve(rawPath);
              if (relative(wtPath, resolved).startsWith("..")) {
                // Path escapes worktree — force it back to worktree root
                args.path = wtPath;
              }
            }
            // For read/write/edit, absolute paths go through security layer as-is
          } else {
            // Relative paths: prepend worktree root
            args.path = require("node:path").join(wtPath, rawPath);
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

      // Inject progress callback for tools that support streaming updates
      const progressFn = (message: string) => {
        onEvent?.({ type: "tool_progress", toolName: tc.name, toolCallId: tc.id, message });
      };
      args._onProgress = progressFn;

      // (worktree rewrite moved before security evaluation)

      try {
        result = await tool.execute(args, signal);
        if (tc.name === "read" && isSensitivePath(String(args.path || ""))) {
          recordSensitiveRead(sessionId || "default", "sensitive_file", String(args.path));
        }
      } catch (e) {
        result = { content: `Tool error: ${(e as Error).message}`, isError: true };
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
        const appPort = process.env.SAX_PORT || "7007";
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
  signal?: AbortSignal
): Promise<ChatCompletionMessageParam[]> {
  const results: ChatCompletionMessageParam[] = [];

  // Execute tools in order, batching adjacent concurrent-safe tools together.
  // This preserves the original call order while parallelizing where safe.
  let i = 0;
  while (i < toolCalls.length) {
    const tc = toolCalls[i];
    const tool = toolMap.get(tc.name);
    const isConcurrent = tool && "concurrencySafe" in tool && (tool as { concurrencySafe?: boolean }).concurrencySafe;

    if (isConcurrent) {
      // Collect adjacent concurrent-safe tools into a batch
      const batch: typeof toolCalls = [tc];
      while (i + 1 < toolCalls.length) {
        const next = toolCalls[i + 1];
        const nextTool = toolMap.get(next.name);
        if (nextTool && "concurrencySafe" in nextTool && (nextTool as { concurrencySafe?: boolean }).concurrencySafe) {
          batch.push(next);
          i++;
        } else break;
      }
      if (batch.length > 1) {
        const parallelResults = await Promise.all(
          batch.map((b) => executeSingleTool(b, toolMap, security, toolPolicy, threatEngine, rbac, callerRole, sessionId, onEvent, signal))
        );
        results.push(...parallelResults.flat());
      } else {
        const msgs = await executeSingleTool(batch[0], toolMap, security, toolPolicy, threatEngine, rbac, callerRole, sessionId, onEvent, signal);
        results.push(...msgs);
      }
    } else {
      const msgs = await executeSingleTool(tc, toolMap, security, toolPolicy, threatEngine, rbac, callerRole, sessionId, onEvent, signal);
      results.push(...msgs);
    }
    i++;
  }

  return results;
}
