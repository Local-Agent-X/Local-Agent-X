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
import { blocked, ok } from "../tools/result-helpers.js";
import { toolMessage, toolMessageStatus, type CarriedToolMessage } from "./tool-message-carry.js";
import { getRiskLevel, buildApprovalContext } from "./approval-context.js";
import { ARI_ACTION_MAP } from "./enforce-policy.js";
import { sessionWorkRootOf } from "../workspace/paths.js";
import { anchorsShellAtCwd, CAPABILITY_CLASS_MEMBERS, readsStamp } from "../tool-registry.js";
import type { TrustedStamp } from "../tool-policy/tool-policies.types.js";
import { LIVE_STATE_TOOLS } from "./stateful-tools.js";
import { readOpMessages } from "../canonical-loop/index.js";
import { READ_DEDUP_STUB_LEAD } from "./read-dedup-evidence.js";
import { cwdOf, isInternalArgKey, withoutInternalArgs } from "./internal-args.js";
import { createLogger } from "../logger.js";

const logger = createLogger("tool-execution.resolve");

// Eval scaffolding — see markDryRunSession docstring below.
const dryRunSessions = new Set<string>();
/** Mark a session so its next tool dispatch returns a synthetic dry-run result. */
export function markDryRunSession(sessionId: string): void { dryRunSessions.add(sessionId); }
/** Clear the dry-run flag — call from a finally block. */
export function unmarkDryRunSession(sessionId: string): void { dryRunSessions.delete(sessionId); }

/** The latest user-authored row of this operation — the message the call answers. */
export function latestUserMessageId(operationId: string): string | undefined {
  const rows = readOpMessages(operationId);
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    const kind = (r.content as { kind?: unknown } | null)?.kind;
    if (r.role === "user" && kind === undefined) return r.messageId;
  }
  return undefined;
}

const SESSION_REPEAT_SKIP_TOOLS: ReadonlySet<string> = new Set([
  // State-sensitive mutations must re-dispatch: every tool that writes files
  // (the workspace-write class, read off each policy row's path specs). A
  // repeated edit/write is often the signal that the previous change already
  // landed (old_string gone) or that a new guard now rejects the path, and
  // restore_file consumes its manifest entry on success — a delete→restore→
  // delete cycle repeats identical args. Returning a prior success is false
  // progress.
  ...CAPABILITY_CLASS_MEMBERS["workspace-write"],
  // Live-state tools (each row's liveState: browser, process/op/agent polling,
  // live captures, status and task lists, a secret request the user answers)
  // share one source of truth with the 60s dedup cache and the threat-engine
  // loop guard — see stateful-tools.ts for the rationale and the 2026-07-23
  // stale-snapshot failure that motivated the exemption.
  ...LIVE_STATE_TOOLS,
]);

type WireCall = { id: string; function: { name: string; arguments: string } };

// Could this call have changed what a later identical call would return?
// Judged by the same predicate plan mode enforces; anything not provably
// read-only — bash included, since a shell can change anything — counts.
function mayChangeState(call: WireCall): boolean {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(call.function.arguments) as Record<string, unknown>; } catch { /* treat as no args */ }
  return !isReadOnlyCall(call.function.name, args);
}

// Scan back through prior assistant tool_calls for an exact match (name +
// args). Catches "I'm stuck mid-task, let me redo the last thing I succeeded
// at" hallucinations without hard-blocking legitimate repeats (the hint lets
// the model realize what it did and pivot).
//
// A replay is only honest if nothing since could have changed the answer. It
// used to ignore everything in between, so "run the tests → edit the code →
// run the tests" got the FIRST run's output back, and the model concluded its
// fix had not worked. Same for "read → edit → read". Any call after the match
// that is not provably read-only now voids the replay; the tool re-executes.
export function findPriorIdenticalResult(
  tc: { id?: string; name: string; arguments: string },
  priorMessages: ChatCompletionMessageParam[],
): { result: string; turnIndex: number } | null {
  if (!priorMessages || priorMessages.length === 0) return null;
  const resultOf = (id: string, from: number): CarriedToolMessage | null => {
    for (let j = from; j < priorMessages.length; j++) {
      const r = priorMessages[j] as unknown as { role: string; tool_call_id?: string } & CarriedToolMessage;
      if (r.role === "tool" && r.tool_call_id === id && typeof r.content === "string") return r;
    }
    return null;
  };
  // Newest first. `changedSince`: some call NEWER than the one being examined
  // may have changed state.
  let changedSince = false;
  for (let i = priorMessages.length - 1; i >= 0; i--) {
    const m = priorMessages[i];
    if (m.role !== "assistant") continue;
    const tcs = (m as unknown as { tool_calls?: WireCall[] }).tool_calls;
    if (!tcs || !Array.isArray(tcs)) continue;
    // The persisted batch can already hold the CURRENT call; only the calls
    // before it in that batch have run.
    const self = tc.id ? tcs.findIndex((t) => t.id === tc.id) : -1;
    const ran = self >= 0 ? tcs.slice(0, self) : tcs;
    for (let k = ran.length - 1; k >= 0; k--) {
      const call = ran[k];
      const identical = call.function.name === tc.name && call.function.arguments === tc.arguments;
      if (identical) {
        const prior = resultOf(call.id, i + 1);
        if (prior !== null) {
          const result = prior.content as string;
          if (changedSince) return null;
          // Only a success is worth replaying: a refusal or a failure may
          // resolve differently now (an approval granted, a file created).
          if (toolMessageStatus(prior) !== "ok") return null;
          // A read-dedup stub carries no content; replaying it answers a
          // re-read with the same nothing (wordy, 2026-09-17).
          if (result.includes(READ_DEDUP_STUB_LEAD)) return null;
          return { result, turnIndex: i };
        }
      }
      if (mayChangeState(call)) changedSince = true;
    }
  }
  return null;
}

// A `_` key is the server's channel to a tool (_cwd, _sessionId, _onProgress,
// _lastUserMessage, …), stamped after parsing. The stamps only fill a key the
// call lacks, and nothing else checked who wrote one, so a model's own
// `_unsafe` ran self_edit with no gates and its `_cwd` moved the shell. The
// call's arguments are the model's, so every `_` key in them is dropped
// before any stamp. `_raw` stays: it is the adapters' marker for arguments
// that did not parse, carried here inside the JSON, and only makes dispatch
// stricter.
function dropModelInternalKeys(ctx: ToolCallContext, args: Record<string, unknown>): Record<string, unknown> {
  const dropped = Object.keys(args).filter((key) => isInternalArgKey(key) && key !== "_raw");
  if (dropped.length === 0) return args;
  for (const key of dropped) delete args[key];
  logger.debug(`[resolve] dropped model-supplied internal args on ${ctx.tc.name}: ${dropped.join(", ")}`);
  return args;
}

async function parseArgs(ctx: ToolCallContext): Promise<void> {
  try {
    const parsed = JSON.parse(ctx.tc.arguments);
    ctx.args = (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      ? dropModelInternalKeys(ctx, parsed as Record<string, unknown>)
      : { _raw: ctx.tc.arguments };
  } catch {
    // Weak models often emit malformed JSON (trailing commas, single quotes,
    // code fences). Attempt progressive relaxation before giving up.
    const { repairJson } = await import("./arg-repair.js");
    const repair = repairJson(ctx.tc.arguments);
    if (repair.ok) {
      ctx.args = dropModelInternalKeys(ctx, repair.value);
      logRetry({ kind: "tool-arg-invalid", sessionId: ctx.sessionId, tool: ctx.tc.name, detail: { phase: "json-repair", fixes: repair.fixes } });
    } else {
      ctx.args = { _raw: ctx.tc.arguments };
    }
  }
}

// The run state each tool reads is its policy row's `reads` (TrustedStamp in
// tool-policies.types.ts). A path-gated tool always gets the session: the gate
// resolved its paths with it, so the tool resolves them with the same one, or
// a work-rooted session gates <workRoot>/x and opens <workspace>/x (live
// failure 2026-07-02). A nested `params._operationId` never reaches a
// collapsed family's action (collapse-family.ts drops a model's `_` keys), so
// the flat stamp is the only one.
async function injectSessionState(ctx: ToolCallContext): Promise<PhaseOutcome> {
  const { tc, args, sessionId, priorMessages } = ctx;
  const reads = (stamp: TrustedStamp) => readsStamp(tc.name, stamp);

  if (reads("session")) args._sessionId = sessionId || "default";
  if (reads("operation")) args._operationId = ctx.operationId;
  if (reads("userMessage") && ctx.operationId) {
    const id = latestUserMessageId(ctx.operationId);
    if (id) args._userMessageId = id;
  }
  // create_chart writes `<file_path>.png` when the suffix is missing. Name the
  // real output here, before the path gate and the artifact pre-stat, so every
  // stage judges the file that will be written (chart-tools.ts chartOutPath).
  if (tc.name === "create_chart" && typeof args.file_path === "string" && args.file_path && !/\.png$/i.test(args.file_path)) {
    args.file_path = `${args.file_path}.png`;
  }

  // The chat's current project flows into the call so the canonical scope
  // (catalog filter + tool gate) follows chat → spawn. Explicit project_id wins.
  if (reads("project") && sessionId && !args.project_id) {
    const { getSessionProject } = await import("../session/project.js");
    const pid = getSessionProject(sessionId);
    if (pid) args.project_id = pid;
  }

  // The last exchange, for a tool that sanity-checks its task against the
  // user's intent (self_edit's intent gate).
  if (reads("lastTurn") && Array.isArray(priorMessages)) {
    const reversed = [...priorMessages].reverse();
    const lastUser = reversed.find(m => m?.role === "user" && typeof m.content === "string");
    const lastAssistant = reversed.find(m => m?.role === "assistant" && typeof m.content === "string");
    if (lastUser?.content) args._lastUserMessage = String(lastUser.content);
    if (lastAssistant?.content) args._lastAssistantMessage = String(lastAssistant.content);
  }

  // Autopilot: anchor a cwd-reading call (bash, self_edit) at the run's
  // checkout and enforce the per-shift self_edit ceiling.
  if (sessionId && reads("cwd")) {
    try {
      const { isAutopilotSession, getAutopilotWorktree, trackSelfEditCall } = await import("../autopilot/registry.js");
      if (isAutopilotSession(sessionId)) {
        const wt = getAutopilotWorktree(sessionId);
        if (wt) args._cwd = wt;
        if (tc.name === "self_edit") {
          const gate = trackSelfEditCall(sessionId);
          if (!gate.allowed) {
            const result = blocked(`BLOCKED: self_edit ceiling reached for this autopilot run (${gate.count}/${gate.max}).`, { layer: "autopilot", userHint: USER_HINTS.retryExhausted, recovery: "Use direct edit/write/bash tools for the rest of this run." });
            return terminate(ctx, { rendered: "model", result, allowed: false });
          }
        }
      }
    } catch { /* registry import failed — fail open, autopilot just not active */ }
  }

  // A work-rooted session (auto-build chunk worker) anchors a cwd-reading
  // shell command at its project dir — the same anchor its file tools resolve
  // against, so the worker's tools agree about what "here" means. Worktree
  // (enforce-policy) and autopilot cwds win; this only fills the default.
  if (anchorsShellAtCwd(tc.name) && sessionId && !cwdOf(args)) {
    const workRoot = sessionWorkRootOf(sessionId);
    if (workRoot) args._cwd = workRoot;
  }

  // Every call gets the session's event sink and its own call id: a card
  // (plan approval, secret destination, a sensitive page), streamed progress
  // (bash, app_rebuild) and the antivirus warning all go out through them.
  // Stamped by name before, so bash, app_rebuild and the email tools read an
  // undefined sink and stayed silent (runtime-coupling audit 2026-10-15, #11).
  // The call context rides along so a gate inside a tool (a sensitive page, a
  // credential fill) knows no person is watching an unattended run and returns
  // a needs-you result for the pipeline to park (deferred-call.ts), instead of
  // raising a card into a sink nobody answers.
  args._onEvent = ctx.onEvent;
  args._toolCallId = tc.id;
  args._callContext = ctx.callContext;
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
    ctx.msgs.push(toolMessage(tc.id, ok(hint), hint));
    return HALT;
  }

  await parseArgs(ctx);

  // Plan mode: block non-read-only tools (session-scoped). Collapsed family
  // tools (spreadsheet/document/pdf) are judged per args.action.
  if (isPlanMode(sessionId) && !isReadOnlyCall(tc.name, ctx.args)) {
    const result = blocked("BLOCKED: Plan mode is active. Only read-only tools are allowed.", { layer: "plan-mode", userHint: USER_HINTS.planMode, recovery: "Keep to read-only tools; call exit_plan_mode when you are ready to make changes." });
    return terminate(ctx, { rendered: "model", result, allowed: false });
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
        const result = blocked(`BLOCKED: ${check.reason}`, { layer: "protected-files", userHint: USER_HINTS.secrets, recovery: "Leave this engine file as it is; if the task needs it changed, tell the user what change it needs." });
        return terminate(ctx, { rendered: "model", result, allowed: false });
      }
    } catch {}
  }

  const injected = await injectSessionState(ctx);
  if (injected.kind === "halt") return injected;

  ctx.riskLevel = getRiskLevel(tc.name, ctx.args, ctx.security);
  ctx.approvalContext = buildApprovalContext(ctx.toolMap.get(tc.name), tc.name, ctx.args);
  // The event carries the model's arguments: the server's stamps are this
  // process's channel to the tool (a sink function among them), not plain
  // JSON a relay or a persisted turn can carry.
  onEvent?.({ type: "tool_start", toolName: tc.name, toolCallId: tc.id, args: withoutInternalArgs(ctx.args), riskLevel: ctx.riskLevel, context: ctx.approvalContext, requiresApproval: ctx.riskLevel === "high" });

  // Dry-run short-circuit. tool_start has fired so observers see the
  // chosen tool, but we never dispatch — no policy eval, no approval
  // prompt, no `tool.execute()`, no side effects.
  if (sessionId && dryRunSessions.has(sessionId)) {
    const dryRunResult = `[dry-run] tool_call captured: ${tc.name}. No side effects executed (eval mode).`;
    return terminate(ctx, { rendered: "raw", content: dryRunResult });
  }

  return CONTINUE;
};
