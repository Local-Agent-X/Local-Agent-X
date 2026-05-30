// Tool-execution phase pair: emit a tool_call_started before the sandbox
// fires and a tool_call_completed after it returns. Short-circuits when
// ctx.runId is absent (chat turns, MCP bridge, ad-hoc dispatches) — the
// trace file is keyed on runId, so no run id means nowhere to write.
//
// Pre-blocked / approval-denied paths skip both phases because they don't
// enter the sandbox block in execute-tool.ts. The tool_end event in
// auditPhase still surfaces a denial to the live UI; the persistent trace
// only records actually-attempted executions.

import { getToolDecision } from "../approval-manager.js";
import { classifyToolRisk } from "../autonomy/risk.js";
import { appendTraceEvent, capValue } from "../agents/run-trace.js";
import type { Phase } from "./context.js";
import { CONTINUE } from "./context.js";

export const emitTraceStartPhase: Phase = async (ctx) => {
  if (!ctx.runId) return CONTINUE;
  appendTraceEvent(ctx.runId, {
    type: "tool_call_started",
    runId: ctx.runId,
    ts: Date.now(),
    toolCallId: ctx.tc.id,
    toolName: ctx.tc.name,
    risk: classifyToolRisk(ctx.tc.name),
    decision: getToolDecision(ctx.tc.name),
    args: capValue(ctx.args),
  });
  return CONTINUE;
};

export const emitTraceCompletePhase: Phase = async (ctx) => {
  if (!ctx.runId) return CONTINUE;
  const result = ctx.result;
  const durationMs = ctx.startedAt ? Date.now() - ctx.startedAt : 0;
  const ok = !!result && !result.isError;
  const preview = result?.content ? capValue(result.content) : "";
  const error = result?.isError && typeof result.content === "string"
    ? result.content.slice(0, 500)
    : undefined;
  appendTraceEvent(ctx.runId, {
    type: "tool_call_completed",
    runId: ctx.runId,
    ts: Date.now(),
    toolCallId: ctx.tc.id,
    ok,
    durationMs,
    resultPreview: preview,
    error,
  });
  return CONTINUE;
};
