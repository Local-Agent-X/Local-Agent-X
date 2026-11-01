// Rollback capture: before a call writes or deletes files, copy aside what
// each file holds now (autonomy/rollback.ts), in every autonomy profile, so
// the change can be undone. Which files a call changes is read off its policy
// row's path args (callPaths), resolved the way the file tools resolve them.
// Capture never blocks the call: a missing backup is reported by the undo,
// while a thrown exception here would refuse a tool the user allowed.
//
// After the call, announceFileChanges tells the chat which files this request
// changed, so the reply can offer an Undo (chat-render-notices.js).

import { captureRollback } from "../autonomy/rollback.js";
import { callPaths } from "../tool-registry.js";
import { resolveAgentPath } from "../workspace/paths.js";
import { createLogger } from "../logger.js";
import type { Phase, ToolCallContext } from "./context.js";
import { CONTINUE } from "./context.js";

const logger = createLogger("tool-execution");

function changedPaths(ctx: ToolCallContext): string[] {
  const { writes, deletes } = callPaths(ctx.tc.name, ctx.args);
  const out: string[] = [];
  for (const p of [...writes, ...deletes]) {
    try { out.push(resolveAgentPath(p, ctx.sessionId)); }
    catch { /* a path no tool can reach is refused before this; nothing to keep */ }
  }
  return out;
}

export const captureRollbackPhase: Phase = async (ctx) => {
  try {
    const contract = captureRollback(
      { toolCallId: ctx.tc.id, tool: ctx.tc.name, sessionId: ctx.sessionId, opId: ctx.operationId },
      changedPaths(ctx),
    );
    if (contract) ctx.rollback = contract;
  } catch (e) {
    logger.warn(`[rollback] capture threw for ${ctx.tc.name}: ${(e as Error).message}`);
  }
  return CONTINUE;
};

/** One line per call that changed files and can be undone: the request's
 *  notice gathers them (chat-stream-reducer.js). Only after the call ran now
 *  and succeeded: a failed write changed nothing to undo. */
export function announceFileChanges(ctx: ToolCallContext): void {
  const r = ctx.result;
  if (!ctx.rollback || !ctx.onEvent || !ctx.operationId || !ctx.sessionId || !r || ctx.resultReused) return;
  if (r.isError || (r.status !== undefined && r.status !== "ok")) return;
  const files = ctx.rollback.artifacts.flatMap((a) => (a.type === "none" ? [] : [a.original]));
  if (files.length === 0) return;
  ctx.onEvent({ type: "file_changes", sessionId: ctx.sessionId, opId: ctx.operationId, files });
}
