// Dedup phase — runs after enforcePolicyPhase (so policy denials win)
// and before requireApprovalPhase. On hit: halts the chain with the prior
// result on ctx.result, annotated so the model sees that this was a
// suppressed repeat call rather than a fresh execution. On miss: no-op;
// the record phase runs after sandbox to capture the result.

import { dedupLookup, dedupRecord } from "./dedup-cache.js";
import type { Phase, ToolCallContext } from "./context.js";
import { CONTINUE, HALT } from "./context.js";

function scopeFor(ctx: ToolCallContext): string | undefined {
  // Prefer runId when the call is part of a spawned-agent run (more
  // specific scope than the chat-session id the agent inherits). Fall
  // back to sessionId for chat-turn and MCP-bridge calls. Both routes
  // land here through tool-execution/execute-tool.ts.
  return ctx.runId || ctx.sessionId || undefined;
}

export const dedupCheckPhase: Phase = async (ctx: ToolCallContext) => {
  const scope = scopeFor(ctx);
  const hit = dedupLookup(scope, ctx.tc.name, ctx.tc.arguments);
  if (!hit) return CONTINUE;

  const annotation =
    `[deduplicated: same args as a prior call this turn — original result reused, no re-execution]`;

  // On a hit we set ctx.result and halt WITHOUT pushing a tool msg or
  // emitting tool_end here: the orchestrator runs the trailing auditPhase
  // for the dedup position, and audit's shapeMsg + tool_end is the SINGLE
  // emitter. Emitting in both places (the old terminate() path) produced
  // two tool messages + two tool_end events under one tool_call_id — the
  // MCP route serialized both and provider replays 400'd on the dup id.
  ctx.allowed = hit.allowed;
  ctx.result = hit.result
    ? { ...hit.result, content: `${hit.result.content}\n\n${annotation}` }
    : hit.allowed
      ? { content: `${hit.resultContent}\n\n${annotation}` }
      : { content: `${hit.resultContent}\n\n${annotation}`, isError: true, status: "blocked" };
  return HALT;
};

/** Post-sandbox record phase. Reads the executed result off ctx and
 *  caches it for the rest of the window. */
export const dedupRecordPhase: Phase = async (ctx: ToolCallContext) => {
  const scope = scopeFor(ctx);
  if (!scope) return CONTINUE;
  // Policy-denied calls have no successful result to cache. This phase only
  // runs on the post-sandbox path (the orchestrator skips it for pre-blocked
  // calls), so an allowed-but-errored result is the only thing to filter
  // here; dedupRecord also filters on allowed + non-error.
  if (!ctx.allowed) return CONTINUE;

  // ctx.msgs holds the tool-role message(s) produced by sandbox/terminate.
  // We snapshot them so a re-issue replays the same conversation content
  // (preserves any structured metadata the caller depended on).
  if (ctx.msgs.length === 0) return CONTINUE;

  const lastMsg = ctx.msgs[ctx.msgs.length - 1];
  const resultContent =
    typeof (lastMsg as { content?: unknown }).content === "string"
      ? (lastMsg as { content: string }).content
      : JSON.stringify((lastMsg as { content: unknown }).content ?? "");

  dedupRecord(scope, ctx.tc.name, ctx.tc.arguments, {
    msgs: [...ctx.msgs],
    allowed: ctx.allowed,
    result: ctx.result,
    resultContent,
  });
  return CONTINUE;
};
