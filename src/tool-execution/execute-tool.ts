// Tool-call orchestrator. Composes the phase chain
// (resolve → policy → approval → sandbox → audit) and provides the parallel
// batcher + single-call dispatcher used by chat-tool-dispatcher, mcp,
// and tests.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { ToolDefinition, ToolResult, ServerEvent } from "../types.js";
import type { SecurityLayer } from "../security/index.js";
import type { ToolPolicy } from "../tool-policy/index.js";
import type { ThreatEngine } from "../threat/threat-engine.js";
import type { RBACManager, Role } from "../rbac.js";
import { createContext, type CallContext } from "./context.js";
import { resolvePhase } from "./resolve-tool.js";
import { enforcePolicyPhase } from "./enforce-policy.js";
import { dedupCheckPhase, dedupRecordPhase } from "./dedup-check.js";
import { requireApprovalPhase } from "./require-approval.js";
import { captureRollbackPhase } from "./capture-rollback.js";
import { emitTraceStartPhase, emitTraceCompletePhase } from "./emit-trace.js";
import { runSandboxedPhase } from "./run-sandboxed.js";
import { auditPhase } from "./audit-tool-call.js";
import { parseStatusHeader } from "../tools/result-helpers.js";
import { hasCapability, WORKTREE_PATH_TOOLS } from "../tool-registry.js";

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
  runId?: string,
  operationId?: string,
  callContext: CallContext = "api",
): Promise<ChatCompletionMessageParam[]> {
  const ctx = createContext({ tc, toolMap, security, toolPolicy, threatEngine, rbac, callerRole, sessionId, runId, operationId, callContext, onEvent, signal, priorMessages });

  if ((await resolvePhase(ctx)).kind === "halt") return ctx.msgs;

  const policy = await enforcePolicyPhase(ctx);
  if (policy.kind === "halt") return ctx.msgs;

  // policy === "block" means the pre-dispatch chain or unknown-tool fired:
  // skip approval + execute, but fall through to audit so the threat engine +
  // hooks see the block and render its message.
  if (policy.kind === "continue" && ctx.tool) {
    // Dedup check sits between policy and approval: policy denials still
    // win (a previously-allowed call doesn't grant future immunity), but
    // a same-args repeat short-circuits before we re-prompt the user for
    // approval or re-execute side effects. See dedup-cache.ts header for
    // the class of bugs this catches (MCP-loop dupes from Anthropic CLI's
    // multi-step tool use). On a dedup hit the phase sets ctx.result and
    // halts WITHOUT emitting; the trailing auditPhase here is the single
    // emitter of the tool msg + tool_end (threat + hooks still observe
    // the reused result, and the model never sees two tool messages under
    // one tool_call_id).
    if ((await dedupCheckPhase(ctx)).kind === "halt") {
      await auditPhase(ctx);
      return ctx.msgs;
    }
    if ((await requireApprovalPhase(ctx)).kind === "halt") return ctx.msgs;
    await captureRollbackPhase(ctx);
    await emitTraceStartPhase(ctx);
    await runSandboxedPhase(ctx);
    await emitTraceCompletePhase(ctx);
    // Record the successful execution AFTER sandbox so a subsequent
    // identical call within the TTL window short-circuits in
    // dedupCheckPhase above. No-op if scope is absent or result errored.
    await dedupRecordPhase(ctx);
  }

  await auditPhase(ctx);
  return ctx.msgs;
}

export interface UnifiedDispatchCtx {
  toolMap: Map<string, ToolDefinition>;
  security: SecurityLayer;
  toolPolicy?: ToolPolicy;
  threatEngine?: ThreatEngine;
  rbac?: RBACManager;
  callerRole?: Role;
  sessionId?: string;
  runId?: string;
  operationId?: string;
  callContext?: CallContext;
  onEvent?: (event: ServerEvent) => void;
  signal?: AbortSignal;
  priorMessages?: ChatCompletionMessageParam[];
}

// Single dispatch entry — input ToolCall, output ToolResult. Internally
// routes through executeSingleTool so the gate chain, retries, hooks,
// circuit-breaker, rate limit, approval, and budgeting all run exactly
// once per dispatch. Closes F2 part 2: any code path that previously
// routed through a parallel dispatcher (the AriKernel `ToolExecutor.execute`
// path, the old `ExecutorRegistry.get`-then-execute pattern) calls this
// instead. Capability tokens / taint labels surface as fields on
// ToolResult.metadata.arikernel rather than a separate execution stack.
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
    ctx.runId,
    ctx.operationId,
    ctx.callContext ?? "api",
  );
  const last = msgs[msgs.length - 1];
  const content = typeof last?.content === "string" ? last.content : "";
  // Recover the real envelope status from the rendered header (the inverse
  // of renderToolResultForModel) — the canonical dispatcher does the same.
  // Hardcoding isError:false here reported blocked/errored/timed-out calls
  // as "ok" to every adopter of this unified entry. `running` stays
  // non-error: the START succeeded, work continues async.
  const status = parseStatusHeader(content);
  return { content, isError: status !== "ok" && status !== "running", status };
}

// Read-only tools are implicitly safe to parallelize (they never mutate
// state). Adjacent parallel-safe tools are batched together; the original
// call order is preserved.
function isParallelSafe(t: ToolDefinition | undefined): boolean {
  if (!t) return false;
  return Boolean(t.readOnly) || Boolean(t.concurrencySafe);
}

// Gate-atomicity guard (R4-09): an egress-capability tool and a sensitive-read
// / path-reading tool must NEVER share one Promise.all batch (one sessionId,
// concurrent). If they did, the egress tool's taint check (policy phase) could
// race the sensitive read's taint floor-set (sandbox phase) and observe an
// empty floor — letting `[read('~/.ssh/id_rsa'), web_search(...)]` exfiltrate.
// Splitting the two classes into separate sequential batches preserves call
// order, so the read completes (and taints) before the egress tool runs.
//
// "Path-reading" includes the worktree path tools (read/glob/grep/...) even
// though some carry no sensitive-read capability label, because a read of a
// sensitive PATH taints from args in the sandbox phase regardless of the
// tool's class — so it, too, must not co-batch with an egress tool.
function isEgressClass(name: string): boolean {
  return hasCapability(name, "egress");
}
function isReadClass(name: string): boolean {
  return hasCapability(name, "sensitive-read") || WORKTREE_PATH_TOOLS.has(name);
}

// Can `candidate` join a parallel batch that already contains `members`
// without putting the egress class and the sensitive-read/path class in the
// same concurrent batch? The two classes are mutually exclusive within a batch.
function isBatchCompatible(candidate: string, members: Array<{ name: string }>): boolean {
  const candEgress = isEgressClass(candidate);
  const candRead = isReadClass(candidate);
  if (!candEgress && !candRead) return true;
  for (const m of members) {
    if (candEgress && isReadClass(m.name)) return false;
    if (candRead && isEgressClass(m.name)) return false;
  }
  return true;
}

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
  runId?: string,
  operationId?: string,
  callContext: CallContext = "api",
): Promise<ChatCompletionMessageParam[]> {
  const results: ChatCompletionMessageParam[] = [];

  let i = 0;
  while (i < toolCalls.length) {
    if (signal?.aborted) break;
    const tc = toolCalls[i];
    const tool = toolMap.get(tc.name);

    if (isParallelSafe(tool)) {
      const batch: typeof toolCalls = [tc];
      while (i + 1 < toolCalls.length) {
        const next = toolCalls[i + 1];
        // Stop the batch at a parallel-unsafe tool, OR at one that would put the
        // egress class and the sensitive-read/path class in the same concurrent
        // Promise.all (R4-09). The next tool still runs — just in the next
        // (sequential) batch, after this one's reads have completed and tainted.
        if (isParallelSafe(toolMap.get(next.name)) && isBatchCompatible(next.name, batch)) {
          batch.push(next);
          i++;
        } else break;
      }
      if (batch.length > 1) {
        const parallel = await Promise.all(
          batch.map((b) => executeSingleTool(b, toolMap, security, toolPolicy, threatEngine, rbac, callerRole, sessionId, onEvent, signal, priorMessages, runId, operationId, callContext)),
        );
        results.push(...parallel.flat());
      } else {
        const msgs = await executeSingleTool(batch[0], toolMap, security, toolPolicy, threatEngine, rbac, callerRole, sessionId, onEvent, signal, priorMessages, runId, operationId, callContext);
        results.push(...msgs);
      }
    } else {
      const msgs = await executeSingleTool(tc, toolMap, security, toolPolicy, threatEngine, rbac, callerRole, sessionId, onEvent, signal, priorMessages, runId, operationId, callContext);
      results.push(...msgs);
    }
    i++;
  }

  return results;
}
