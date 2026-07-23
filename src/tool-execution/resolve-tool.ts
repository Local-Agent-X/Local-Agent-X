// Resolve phase: parse args, dup-check, inject
// session/worktree/onEvent state, compute risk + approval context, emit
// tool_start, short-circuit dry-run + plan-mode + protected-file blocks,
// look up the tool. Pre-policy: any block here returns the standard
// rendered-raw msg shape.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { USER_HINTS } from "../types.js";
import { isPlanMode, isReadOnlyCall } from "../tools/plan-tools.js";
import { logRetry } from "../retry-telemetry.js";
import type { Phase, PhaseOutcome, ToolCallContext } from "./context.js";
import { terminate, CONTINUE, HALT } from "./context.js";
import { getRiskLevel, buildApprovalContext } from "./approval-context.js";
import { ARI_ACTION_MAP } from "./enforce-policy.js";
import { sessionWorkRootOf } from "../workspace/paths.js";
import { STATEFUL_LIVE_STATE_TOOLS } from "./stateful-tools.js";

// Eval scaffolding — see markDryRunSession docstring below.
const dryRunSessions = new Set<string>();
/** Mark a session so its next tool dispatch returns a synthetic dry-run result. */
export function markDryRunSession(sessionId: string): void { dryRunSessions.add(sessionId); }
/** Clear the dry-run flag — call from a finally block. */
export function unmarkDryRunSession(sessionId: string): void { dryRunSessions.delete(sessionId); }

// Tools that need session-scoped state stamped into their args.
const SESSION_SCOPED_TOOLS = new Set([
  "enter_plan_mode", "exit_plan_mode", "skill_run", "usage_report",
  "browser",
  "agent_spawn", "browser_capture_to_secret", "browser_fill_from_secret",
  "session_status", "request_secret", "request_secrets",
  "voice_visual",
  // task_create/task_update stamp the session onto the task so the open-steps
  // completion gate can scope "unfinished work" to this conversation, and an
  // upserted task_update (unknown id → create) is owned by the right session
  // (task-tools.ts).
  "task_create", "task_update", "task_list", "task_get",
  "op_submit", "op_submit_async", "op_wait", "op_status",
  "memory_search", "search_past_sessions", "memory_save", "remember", "update_fact",
  // recall resolves session→op from the trusted _sessionId (recall-tool.ts).
  "recall",
  "memory_set_user_field", "memory_update_profile",
  "project_brief_update", "project_create",
  "self_edit",
  "build_app", "start_app_build", "finalize_app_build",
  "agent_escalate",
  // AriKernel bridge synonyms: stamp the trusted `_sessionId` so the bridge
  // derives runId/principal from trusted context (arikernel-bridge.ts), not
  // from forged model-supplied `_runId`/`_principalId`.
  "ari_file", "ari_http", "ari_shell", "ari_database", "ari_retrieval", "ari_sqlite",
  // Path-taking file tools: sessionIdOf(args) feeds resolveAgentPath so a
  // session with a registered work root (auto-build chunk workers) anchors
  // relative paths there. Without the stamp the work-root registry is dead
  // code — the resolver never learns which session is calling (live failure
  // 2026-07-02: worker's relative read resolved to the workspace parent).
  "read", "write", "edit", "multi_edit", "edit_lines", "bulk_replace", "delete_file", "glob", "grep",
  "structural_search", // searchRoot(args) is session-anchored like grep's
]);

// `protocol` is the model-facing collapsed family. Keep the inner name for
// direct/core callers, but never trust either a flat or nested model value.
const OPERATION_SCOPED_TOOLS = new Set(["protocol", "protocol_get"]);

const SESSION_REPEAT_SKIP_TOOLS = new Set([
  "request_secret", "request_secrets",
  // State-sensitive mutations must re-dispatch. A repeated edit/write is often
  // the signal that the previous change already landed (old_string gone) or
  // that a new guard now rejects the path. Returning a prior success is false
  // progress.
  "write", "edit", "edit_lines", "multi_edit", "bulk_replace", "delete_file",
  // STATEFUL live-state tools (browser, process/op/agent polling, live
  // captures) share one source of truth with the 60s dedup cache and the
  // threat-engine loop guard — see stateful-tools.ts for the rationale and the
  // 2026-07-23 stale-snapshot failure that motivated the exemption.
  ...STATEFUL_LIVE_STATE_TOOLS,
]);

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
        if (/(^|\n)\[error\](\r?\n|$)/i.test(r.content)) return null;
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
    const { repairJson } = await import("./arg-repair.js");
    const repair = repairJson(ctx.tc.arguments);
    if (repair.ok) {
      ctx.args = repair.value;
      logRetry({ kind: "tool-arg-invalid", sessionId: ctx.sessionId, tool: ctx.tc.name, detail: { phase: "json-repair", fixes: repair.fixes } });
    } else {
      ctx.args = { _raw: ctx.tc.arguments };
    }
  }
}

async function injectSessionState(ctx: ToolCallContext): Promise<PhaseOutcome> {
  const { tc, args, sessionId, priorMessages } = ctx;

  if (SESSION_SCOPED_TOOLS.has(tc.name)) {
    args._sessionId = sessionId || "default";
  }
  if (OPERATION_SCOPED_TOOLS.has(tc.name)) {
    args._operationId = ctx.operationId;
    if (args.params && typeof args.params === "object" && !Array.isArray(args.params)) {
      (args.params as Record<string, unknown>)._operationId = ctx.operationId;
    }
  }

  // Inject the chat's current project into agent_* tool calls so the
  // canonical scope (catalog filter + tool gate) flows from chat → spawn
  // automatically. Explicit project_id wins.
  if ((tc.name === "agent_spawn" || tc.name === "agent_list" || tc.name === "agent_create") && sessionId) {
    if (!args.project_id) {
      const { getSessionProject } = await import("../session/project.js");
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
            return terminate(ctx, { rendered: "raw", content: result, allowed: false });
          }
        }
      }
    } catch { /* registry import failed — fail open, autopilot just not active */ }
  }

  // A work-rooted session (auto-build chunk worker) anchors bash at its
  // project dir — the same anchor its file tools resolve against, so the
  // worker's tools agree about what "here" means. Worktree (enforce-policy)
  // and autopilot cwds win; this only fills the default.
  if (tc.name === "bash" && sessionId && !args._cwd) {
    const workRoot = sessionWorkRootOf(sessionId);
    if (workRoot) args._cwd = workRoot;
  }

  // Inject onEvent for tools that need to stream events. exit_plan_mode
  // needs it to raise the plan-approval card under enforced plan mode (plus
  // the tool-call id so the card resolves against the right call).
  if (
    tc.name === "request_secret" ||
    tc.name === "request_secrets" ||
    tc.name === "browser" ||
    tc.name === "voice_visual" ||
    tc.name === "build_app" ||
    tc.name === "exit_plan_mode"
  ) {
    args._onEvent = ctx.onEvent;
    args._toolCallId = tc.id;
  }
  return CONTINUE;
}

export const resolvePhase: Phase = async (ctx) => {
  const { tc, priorMessages, sessionId, onEvent } = ctx;

  // Session-wide duplicate check — short-circuit before any execution.
  // request_secret is exempt: it emits a UI side-effect (secret_request SSE
  // event → modal) so re-running it on retry is the whole point when the
  // user missed the first prompt.
  const dup = SESSION_REPEAT_SKIP_TOOLS.has(tc.name) ? null : findPriorIdenticalResult(tc, priorMessages || []);
  if (dup) {
    const hint = `[REPEATED CALL — identical to a tool call made earlier this session. Returning the previous result without re-executing. If you need fresh data, change the arguments. Otherwise, focus on the user's current question.]\n\n${dup.result}`;
    onEvent?.({ type: "tool_end", toolName: tc.name, toolCallId: tc.id, result: hint, allowed: true, status: "ok" });
    logRetry({ kind: "custom", sessionId, tool: tc.name, detail: { reason: "session-repeat", priorTurn: dup.turnIndex } });
    ctx.msgs.push({ role: "tool", tool_call_id: tc.id, content: hint } as ChatCompletionMessageParam);
    return HALT;
  }

  await parseArgs(ctx);

  // Plan mode: block non-read-only tools (session-scoped). Collapsed family
  // tools (spreadsheet/document/pdf) are judged per args.action.
  if (isPlanMode(sessionId) && !isReadOnlyCall(tc.name, ctx.args)) {
    const result = `User hint: ${USER_HINTS.planMode}\nBLOCKED: Plan mode is active. Only read-only tools are allowed. Use exit_plan_mode to restore full access.`;
    return terminate(ctx, { rendered: "raw", content: result, allowed: false });
  }

  // Protected files: block writes/deletes to core engine files that would
  // brick the agent. Keyed on the write-action file family (ARI_ACTION_MAP:
  // write/edit/edit_lines/multi_edit/delete_file), not a literal name list —
  // multi_edit and edit_lines are registered edit synonyms with identical
  // blast radius, and delete_file is included because deletion+recreation
  // is the same blast radius as a write — both flatten the original content.
  if (ARI_ACTION_MAP[tc.name] === "write" && ctx.args.path) {
    try {
      const { isProtectedFile } = await import("../config-loader.js");
      const check = isProtectedFile(String(ctx.args.path));
      if (check.protected) {
        const result = `User hint: ${USER_HINTS.secrets}\nBLOCKED: ${check.reason}`;
        return terminate(ctx, { rendered: "raw", content: result, allowed: false });
      }
    } catch {}
  }

  const injected = await injectSessionState(ctx);
  if (injected.kind === "halt") return injected;

  ctx.riskLevel = getRiskLevel(tc.name, ctx.args, ctx.security);
  ctx.approvalContext = buildApprovalContext(tc.name, ctx.args);
  onEvent?.({ type: "tool_start", toolName: tc.name, toolCallId: tc.id, args: ctx.args, riskLevel: ctx.riskLevel, context: ctx.approvalContext, requiresApproval: ctx.riskLevel === "high" });

  // Dry-run short-circuit. tool_start has fired so observers see the
  // chosen tool, but we never dispatch — no policy eval, no approval
  // prompt, no `tool.execute()`, no side effects.
  if (sessionId && dryRunSessions.has(sessionId)) {
    const dryRunResult = `[dry-run] tool_call captured: ${tc.name}. No side effects executed (eval mode).`;
    return terminate(ctx, { rendered: "raw", content: dryRunResult, allowed: true });
  }

  return CONTINUE;
};
