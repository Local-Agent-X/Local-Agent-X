// Tool-call orchestrator. Composes the phase chain
// (resolve → policy → approval → sandbox → audit) and provides the parallel
// batcher + single-call dispatcher used by chat-tool-dispatcher, mcp,
// and tests.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { ToolDefinition, ToolResult, ServerEvent } from "../types.js";
import type { SecurityLayer } from "../security/index.js";
import type { ToolPolicy } from "../tool-policy.js";
import type { ThreatEngine } from "../threat-engine.js";
import type { RBACManager, Role } from "../rbac.js";
import { compactIfNeeded, compactIfNeededWithLLM } from "../context-manager/index.js";
import { createContext } from "./context.js";
import { resolvePhase } from "./resolve-tool.js";
import { enforcePolicyPhase } from "./enforce-policy.js";
import { dedupCheckPhase, dedupRecordPhase } from "./dedup-check.js";
import { requireApprovalPhase } from "./require-approval.js";
import { captureRollbackPhase } from "./capture-rollback.js";
import { emitTraceStartPhase, emitTraceCompletePhase } from "./emit-trace.js";
import { runSandboxedPhase } from "./run-sandboxed.js";
import { auditPhase } from "./audit-tool-call.js";

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
): Promise<ChatCompletionMessageParam[]> {
  const ctx = createContext({ tc, toolMap, security, toolPolicy, threatEngine, rbac, callerRole, sessionId, runId, onEvent, signal, priorMessages });

  await resolvePhase(ctx);
  if (ctx.terminated) return ctx.msgs;

  await enforcePolicyPhase(ctx);
  if (ctx.terminated) return ctx.msgs;

  if (!ctx.preBlocked && ctx.tool) {
    // Dedup check sits between policy and approval: policy denials still
    // win (a previously-allowed call doesn't grant future immunity), but
    // a same-args repeat short-circuits before we re-prompt the user for
    // approval or re-execute side effects. See dedup-cache.ts header for
    // the class of bugs this catches (MCP-loop dupes from Anthropic CLI's
    // multi-step tool use).
    await dedupCheckPhase(ctx);
    if (ctx.terminated) {
      await auditPhase(ctx);
      return ctx.msgs;
    }
    await requireApprovalPhase(ctx);
    if (ctx.terminated) return ctx.msgs;
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

export function checkAndCompact(
  messages: ChatCompletionMessageParam[],
  model: string,
  onEvent?: (event: ServerEvent) => void,
  force: boolean = false,
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

// Async variant — uses real LLM summarization instead of string truncation.
// Falls back to the sync truncation path internally if the LLM call fails so
// compaction never blocks.
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

export interface UnifiedDispatchCtx {
  toolMap: Map<string, ToolDefinition>;
  security: SecurityLayer;
  toolPolicy?: ToolPolicy;
  threatEngine?: ThreatEngine;
  rbac?: RBACManager;
  callerRole?: Role;
  sessionId?: string;
  runId?: string;
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
  );
  const last = msgs[msgs.length - 1];
  const content = typeof last?.content === "string" ? last.content : "";
  return { content, isError: false, status: "ok" };
}

// Read-only tools are implicitly safe to parallelize (they never mutate
// state). Adjacent parallel-safe tools are batched together; the original
// call order is preserved.
function isParallelSafe(t: ToolDefinition | undefined): boolean {
  if (!t) return false;
  return Boolean(t.readOnly) || Boolean(t.concurrencySafe);
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
): Promise<ChatCompletionMessageParam[]> {
  const results: ChatCompletionMessageParam[] = [];

  let i = 0;
  while (i < toolCalls.length) {
    const tc = toolCalls[i];
    const tool = toolMap.get(tc.name);

    if (isParallelSafe(tool)) {
      const batch: typeof toolCalls = [tc];
      while (i + 1 < toolCalls.length) {
        const next = toolCalls[i + 1];
        if (isParallelSafe(toolMap.get(next.name))) {
          batch.push(next);
          i++;
        } else break;
      }
      if (batch.length > 1) {
        const parallel = await Promise.all(
          batch.map((b) => executeSingleTool(b, toolMap, security, toolPolicy, threatEngine, rbac, callerRole, sessionId, onEvent, signal, priorMessages, runId)),
        );
        results.push(...parallel.flat());
      } else {
        const msgs = await executeSingleTool(batch[0], toolMap, security, toolPolicy, threatEngine, rbac, callerRole, sessionId, onEvent, signal, priorMessages, runId);
        results.push(...msgs);
      }
    } else {
      const msgs = await executeSingleTool(tc, toolMap, security, toolPolicy, threatEngine, rbac, callerRole, sessionId, onEvent, signal, priorMessages, runId);
      results.push(...msgs);
    }
    i++;
  }

  return results;
}
