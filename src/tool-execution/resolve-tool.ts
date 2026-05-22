// Resolve phase: parse args, dup-check, derive callContext, inject
// session/worktree/onEvent state, compute risk + approval context, emit
// tool_start, short-circuit dry-run + plan-mode + protected-file blocks,
// look up the tool. Pre-policy: any block here returns the standard
// rendered-raw msg shape.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { USER_HINTS } from "../types.js";
import { isPlanMode, READ_ONLY_TOOLS } from "../plan-tools.js";
import { logRetry } from "../retry-telemetry.js";
import type { CallContext, Phase, ToolCallContext } from "./context.js";
import { terminate } from "./context.js";
import { getRiskLevel, buildApprovalContext } from "./approval-context.js";

// Eval scaffolding — see markDryRunSession docstring below.
const dryRunSessions = new Set<string>();
/** Mark a session so its next tool dispatch returns a synthetic dry-run result. */
export function markDryRunSession(sessionId: string): void { dryRunSessions.add(sessionId); }
/** Clear the dry-run flag — call from a finally block. */
export function unmarkDryRunSession(sessionId: string): void { dryRunSessions.delete(sessionId); }

// Tools that need session-scoped state stamped into their args.
const SESSION_SCOPED_TOOLS = new Set([
  "enter_plan_mode", "exit_plan_mode", "skill_run", "usage_report",
  "browser", "operation_start",
  "agent_spawn", "browser_capture_to_secret", "browser_fill_from_secret",
  "session_status", "request_secret", "request_secrets",
  "voice_visual",
  "op_submit", "op_submit_async", "op_wait", "op_status",
  "memory_search", "search_past_sessions", "memory_save",
  "self_edit",
  "build_app",
  "agent_escalate",
]);

function deriveCallContext(sessionId: string | undefined): CallContext {
  return sessionId?.startsWith("agent-") ? "delegated" : sessionId?.startsWith("cron-") ? "cron" : "local";
}

// Scan back through prior assistant tool_calls for an exact match (name +
// args). Catches "I'm stuck mid-task, let me redo the last thing I succeeded
// at" hallucinations without hard-blocking legitimate repeats (the hint lets
// the model realize what it did and pivot).
function findPriorIdenticalResult(
  tc: { name: string; arguments: string },
  priorMessages: ChatCompletionMessageParam[],
): { result: string; turnIndex: number } | null {
  if (!priorMessages || priorMessages.length === 0) return null;
  for (let i = priorMessages.length - 1; i >= 0; i--) {
    const m = priorMessages[i];
    if (m.role !== "assistant") continue;
    const tcs = (m as unknown as { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }).tool_calls;
    if (!tcs || !Array.isArray(tcs)) continue;
    const match = tcs.find(t => t.function.name === tc.name && t.function.arguments === tc.arguments);
    if (!match) continue;
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

async function parseArgs(ctx: ToolCallContext): Promise<void> {
  try {
    const parsed = JSON.parse(ctx.tc.arguments);
    ctx.args = (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      ? parsed as Record<string, unknown>
      : { _raw: ctx.tc.arguments };
  } catch {
    // Weak models often emit malformed JSON (trailing commas, single quotes,
    // code fences). Attempt progressive relaxation before giving up.
    const { repairJson } = await import("../tool-arg-repair.js");
    const repair = repairJson(ctx.tc.arguments);
    if (repair.ok) {
      ctx.args = repair.value;
      logRetry({ kind: "tool-arg-invalid", sessionId: ctx.sessionId, tool: ctx.tc.name, detail: { phase: "json-repair", fixes: repair.fixes } });
    } else {
      ctx.args = { _raw: ctx.tc.arguments };
    }
  }
}

async function injectSessionState(ctx: ToolCallContext): Promise<void> {
  const { tc, args, sessionId, priorMessages } = ctx;

  if (SESSION_SCOPED_TOOLS.has(tc.name)) {
    args._sessionId = sessionId || "default";
  }

  // Inject the chat's current project into agent_* tool calls so the
  // canonical scope (catalog filter + tool gate) flows from chat → spawn
  // automatically. Explicit project_id wins.
  if ((tc.name === "agent_spawn" || tc.name === "agent_list" || tc.name === "agent_create") && sessionId) {
    if (!args.project_id) {
      const { getSessionProject } = await import("../session-project.js");
      const pid = getSessionProject(sessionId);
      if (pid) args.project_id = pid;
    }
  }

  // Inject conversational context for tools that need to sanity-check their
  // task against user intent (currently self_edit's intent gate).
  if (tc.name === "self_edit" && Array.isArray(priorMessages)) {
    const reversed = [...priorMessages].reverse();
    const lastUser = reversed.find(m => m?.role === "user" && typeof m.content === "string");
    const lastAssistant = reversed.find(m => m?.role === "assistant" && typeof m.content === "string");
    if (lastUser?.content) args._lastUserMessage = String(lastUser.content);
    if (lastAssistant?.content) args._lastAssistantMessage = String(lastAssistant.content);
  }

  // Autopilot: route bash/self_edit at the worktree CWD and enforce the
  // per-shift self_edit ceiling.
  if (sessionId && (tc.name === "self_edit" || tc.name === "bash")) {
    try {
      const { isAutopilotSession, getAutopilotWorktree, trackSelfEditCall } = await import("../autopilot/registry.js");
      if (isAutopilotSession(sessionId)) {
        const wt = getAutopilotWorktree(sessionId);
        if (wt && !args._cwd) args._cwd = wt;
        if (tc.name === "self_edit") {
          const gate = trackSelfEditCall(sessionId);
          if (!gate.allowed) {
            const result = `User hint: ${USER_HINTS.retryExhausted}\nBLOCKED: self_edit ceiling reached for this autopilot run (${gate.count}/${gate.max}). Use direct edit/write/bash tools instead.`;
            terminate(ctx, { rendered: "raw", content: result, allowed: false });
            return;
          }
        }
      }
    } catch { /* registry import failed — fail open, autopilot just not active */ }
  }

  // Inject onEvent for tools that need to stream events.
  if (
    tc.name === "request_secret" ||
    tc.name === "request_secrets" ||
    tc.name === "browser" ||
    tc.name === "voice_visual" ||
    tc.name === "build_app"
  ) {
    args._onEvent = ctx.onEvent;
  }
}

export const resolvePhase: Phase = async (ctx) => {
  const { tc, priorMessages, sessionId, onEvent } = ctx;

  // Session-wide duplicate check — short-circuit before any execution.
  // request_secret is exempt: it emits a UI side-effect (secret_request SSE
  // event → modal) so re-running it on retry is the whole point when the
  // user missed the first prompt.
  const dup = (tc.name === "request_secret" || tc.name === "request_secrets") ? null : findPriorIdenticalResult(tc, priorMessages || []);
  if (dup) {
    const hint = `[REPEATED CALL — identical to a tool call made earlier this session. Returning the previous result without re-executing. If you need fresh data, change the arguments. Otherwise, focus on the user's current question.]\n\n${dup.result}`;
    onEvent?.({ type: "tool_end", toolName: tc.name, toolCallId: tc.id, result: hint, allowed: true });
    logRetry({ kind: "custom", sessionId, tool: tc.name, detail: { reason: "session-repeat", priorTurn: dup.turnIndex } });
    ctx.msgs.push({ role: "tool", tool_call_id: tc.id, content: hint } as ChatCompletionMessageParam);
    ctx.terminated = true;
    return;
  }

  await parseArgs(ctx);
  ctx.callContext = deriveCallContext(sessionId);

  // Plan mode: block non-read-only tools (session-scoped).
  if (isPlanMode(sessionId) && !READ_ONLY_TOOLS.has(tc.name)) {
    const result = `User hint: ${USER_HINTS.planMode}\nBLOCKED: Plan mode is active. Only read-only tools are allowed. Use exit_plan_mode to restore full access.`;
    terminate(ctx, { rendered: "raw", content: result, allowed: false });
    return;
  }

  // Protected files: block writes to core engine files that would brick the agent.
  if (["write", "edit"].includes(tc.name) && ctx.args.path) {
    try {
      const { isProtectedFile } = await import("../config-loader.js");
      const check = isProtectedFile(String(ctx.args.path));
      if (check.protected) {
        const result = `User hint: ${USER_HINTS.secrets}\nBLOCKED: ${check.reason}. This file is part of the protected core — modifying it could break the agent engine. Edit config/ files instead to customize behavior.`;
        terminate(ctx, { rendered: "raw", content: result, allowed: false });
        return;
      }
    } catch {}
  }

  await injectSessionState(ctx);
  if (ctx.terminated) return;

  ctx.riskLevel = getRiskLevel(tc.name, ctx.args, ctx.security);
  ctx.approvalContext = buildApprovalContext(tc.name, ctx.args);
  onEvent?.({ type: "tool_start", toolName: tc.name, toolCallId: tc.id, args: ctx.args, riskLevel: ctx.riskLevel, context: ctx.approvalContext, requiresApproval: ctx.riskLevel === "high" });

  // Dry-run short-circuit. tool_start has fired so observers see the
  // chosen tool, but we never dispatch — no policy eval, no approval
  // prompt, no `tool.execute()`, no side effects.
  if (sessionId && dryRunSessions.has(sessionId)) {
    const dryRunResult = `[dry-run] tool_call captured: ${tc.name}. No side effects executed (eval mode).`;
    terminate(ctx, { rendered: "raw", content: dryRunResult, allowed: true });
    return;
  }
};
