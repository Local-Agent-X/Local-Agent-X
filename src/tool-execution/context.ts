import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { ToolDefinition, ToolResult, ServerEvent } from "../types.js";
import type { SecurityLayer } from "../security/index.js";
import type { ToolPolicy } from "../tool-policy/index.js";
import type { ThreatEngine } from "../threat/threat-engine.js";
import type { RBACManager, Role } from "../rbac.js";
import { ok, statusOf } from "../tools/result-helpers.js";
import { toolMessage } from "./tool-message-carry.js";

export type CallContext = "local" | "api" | "delegated" | "cron";

export interface ToolCallContext {
  readonly tc: { id: string; name: string; arguments: string };
  readonly toolMap: Map<string, ToolDefinition>;
  readonly security: SecurityLayer;
  readonly toolPolicy?: ToolPolicy;
  readonly threatEngine?: ThreatEngine;
  readonly rbac?: RBACManager;
  readonly callerRole?: Role;
  readonly sessionId?: string;
  /** Stable run id when this tool call is part of an agent run (canonical-loop
   *  agent-runner threads its agentId/runId through here). Absent for chat
   *  turns, MCP bridge calls, and other ad-hoc dispatches — the trace
   *  emit-phase short-circuits when absent. */
  readonly runId?: string;
  /** Canonical operation id used to isolate mutable ARI run state. */
  readonly operationId?: string;
  readonly onEvent?: (event: ServerEvent) => void;
  readonly signal?: AbortSignal;
  readonly priorMessages?: ChatCompletionMessageParam[];

  readonly callContext: CallContext;
  args: Record<string, unknown>;
  tool?: ToolDefinition;
  riskLevel: "low" | "medium" | "high";
  approvalContext: string;
  /** Set by policy when a rule permits the exact call only after user
   * approval. The canonical approval phase owns the prompt. */
  policyApprovalReason?: string;
  /** Set by the approval phase when the user said yes to this call, on its
   * card or by a remembered "always allow" for its scope. */
  approvedByUser?: true;
  /** Set when this dispatch consumed the user's one-shot yes to this exact
   * call (deferred-call.ts takeUserGrant). Every later gate in the same
   * dispatch that would park, refuse or prompt for want of a person reads it
   * instead of asking again; nothing else sets it. */
  userGrantId?: string;
  /** Set by the PreToolUse hook phase when a user hook rewrote the args.
   * enforcePolicyPhase consumes it: applies the rewrite to `args`, then
   * re-runs the security + validation gates on the rewritten call. */
  hookRewrittenArgs?: Record<string, unknown>;

  /** Set by the approval phase when this call publishes (publish-review-gate.ts):
   * the pre-publish review, noted onto the tool result after it runs. */
  publishReview?: import("../canonical-loop/public/publish-review.js").PublishReview;

  startedAt?: number;
  result?: ToolResult;
  /** Set when ctx.result was satisfied WITHOUT the tool executing in THIS
   * invocation: a side-effect-journal decision that suppressed execution
   * (crash-recovery replay of a completed entry, or its blocked siblings —
   * run-sandboxed sets it) or a dedup-cache hit (dedup-check sets it).
   * Execution-effect recorders (provenance) must skip when set — the write
   * they would attribute did not happen now. */
  resultReused?: "journal-replay" | "dedup-cache";

  allowed: boolean;
  msgs: ChatCompletionMessageParam[];
}

// A phase's control-flow signal to the orchestrator, replacing the old
// hidden `ctx.terminated` / `ctx.preBlocked` flags read between phase calls.
//   continue — chain proceeds to the next phase.
//   halt     — phase produced the final tool message (via `terminate`) and
//              the chain stops. The orchestrator decides whether a trailing
//              audit runs (it does only for the dedup-hit position).
//   block    — pre-dispatch chain (security/RBAC/tool-policy) or unknown-tool
//              fired: `ctx.result` is set but no message was pushed. Skips
//              approval + execute; audit still runs so the threat engine +
//              hooks see the block and render its message.
export type PhaseOutcome =
  | { kind: "continue" }
  | { kind: "halt" }
  | { kind: "block" };

export const CONTINUE: PhaseOutcome = { kind: "continue" };
export const HALT: PhaseOutcome = { kind: "halt" };
export const BLOCK: PhaseOutcome = { kind: "block" };

export type Phase = (ctx: ToolCallContext) => Promise<PhaseOutcome>;

export function createContext(input: {
  tc: { id: string; name: string; arguments: string };
  toolMap: Map<string, ToolDefinition>;
  security: SecurityLayer;
  toolPolicy?: ToolPolicy;
  threatEngine?: ThreatEngine;
  rbac?: RBACManager;
  callerRole?: Role;
  callContext?: CallContext;
  sessionId?: string;
  runId?: string;
  operationId?: string;
  onEvent?: (event: ServerEvent) => void;
  signal?: AbortSignal;
  priorMessages?: ChatCompletionMessageParam[];
}): ToolCallContext {
  return {
    tc: input.tc,
    toolMap: input.toolMap,
    security: input.security,
    toolPolicy: input.toolPolicy,
    threatEngine: input.threatEngine,
    rbac: input.rbac,
    callerRole: input.callerRole,
    sessionId: input.sessionId,
    runId: input.runId,
    operationId: input.operationId,
    onEvent: input.onEvent,
    signal: input.signal,
    priorMessages: input.priorMessages,
    callContext: input.callContext ?? "api",
    args: {},
    riskLevel: "low",
    approvalContext: "",
    policyApprovalReason: undefined,
    allowed: true,
    msgs: [],
  };
}

// Build the final tool msg, emit tool_end, and return the halt outcome so the
// calling phase short-circuits the chain. `rendered: "raw"` writes content
// verbatim (used by paths that build a human-readable string directly).
// `rendered: "model"` runs the content through renderToolResultForModel for
// ToolResult-shaped values.
export function terminate(
  ctx: ToolCallContext,
  // A refusal is never raw: it goes out as a blocked() result, so the event
  // log, the block record and the model all read it as blocked, not "ok".
  payload:
    | { rendered: "raw"; content: string }
    | { rendered: "model"; result: ToolResult; allowed: boolean },
): PhaseOutcome {
  if (payload.rendered === "raw") {
    ctx.allowed = true;
    ctx.onEvent?.({ type: "tool_end", toolName: ctx.tc.name, toolCallId: ctx.tc.id, result: payload.content, allowed: true, status: "ok" });
    ctx.msgs.push(toolMessage(ctx.tc.id, ok(payload.content), payload.content));
  } else {
    ctx.allowed = payload.allowed;
    ctx.result = payload.result;
    ctx.onEvent?.({ type: "tool_end", toolName: ctx.tc.name, toolCallId: ctx.tc.id, result: payload.result.content, allowed: payload.allowed, status: statusOf(payload.result), metadata: payload.result.metadata });
    ctx.msgs.push(toolMessage(ctx.tc.id, payload.result));
  }
  return HALT;
}
