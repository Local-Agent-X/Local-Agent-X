// Rollback capture: before a call writes or deletes files, copy aside what
// each file holds now (autonomy/rollback.ts), in every autonomy profile, so
// the change can be undone. Which files a call changes is read off its policy
// row's path args (callPaths), resolved the way the file tools resolve them.
// A shell command names its files in its text: the ones it writes (a
// redirection, tee, sed -i's operand) and every existing file it names
// (a database it opens, a file it removes), read by the canonical shell
// parsers (create-target-path.ts) in the folder it runs in.
// Capture never blocks the call: a missing backup is reported by the undo,
// while a thrown exception here would refuse a tool the user allowed.
//
// After the call, recordFileChanges keeps what it changed and tells the chat,
// so the reply can offer an Undo (chat-render-notices.js).

import { statSync } from "node:fs";
import { captureBeforeCall, recordCapture } from "../autonomy/rollback.js";
import { callPaths, shellCommandOf } from "../tool-registry.js";
import { resolveAgentPath } from "../workspace/paths.js";
import { workspaceRoot } from "../config.js";
import { createLogger } from "../logger.js";
import { shellCreateTargets, shellNamedPaths } from "./create-target-path.js";
import { cwdOf } from "./internal-args.js";
import type { Phase, ToolCallContext } from "./context.js";
import { CONTINUE } from "./context.js";

const logger = createLogger("tool-execution");

/** SQLite keeps committed pages beside the database until a checkpoint folds
 *  them in, and opening the database can fold them and delete the file: a
 *  copy of the database alone restores it without them (TB2
 *  db-wal-recovery, 2026-10-31). */
const SQLITE_SIDECARS = ["-wal", "-shm", "-journal"];

/** Per request, the files already on record: the rewind needs only a file's
 *  first recorded copy, so a later shell command naming it copies nothing.
 *  Only RECORDED files count: one a command named but left alone is copied
 *  again next time, so the command that does change it is still captured.
 *  Bounded: the oldest requests drop out. */
const recordedForOp = new Map<string, Set<string>>();
const RECORDED_OPS = 100;

const isFile = (p: string): boolean => {
  try { return statSync(p).isFile(); } catch { return false; }
};

function fileToolPaths(ctx: ToolCallContext): string[] {
  const { writes, deletes } = callPaths(ctx.tc.name, ctx.args);
  const out: string[] = [];
  for (const p of [...writes, ...deletes]) {
    try { out.push(resolveAgentPath(p, ctx.sessionId)); }
    catch { /* a path no tool can reach is refused before this; nothing to keep */ }
  }
  return out;
}

function shellPaths(ctx: ToolCallContext): string[] {
  const command = shellCommandOf(ctx.tc.name, ctx.args);
  if (!command) return [];
  const cwd = cwdOf(ctx.args) || workspaceRoot();
  const writes = shellCreateTargets(command, cwd);
  const named = shellNamedPaths(command, cwd).filter(isFile);
  const sidecars = [...writes, ...named].flatMap((p) => SQLITE_SIDECARS.map((s) => p + s)).filter(isFile);
  const recorded = ctx.operationId ? recordedForOp.get(ctx.operationId) : undefined;
  return [...new Set([...writes, ...named, ...sidecars])].filter((p) => !recorded?.has(p));
}

function noteRecorded(opId: string, files: string[]): void {
  const set = recordedForOp.get(opId) ?? new Set<string>();
  for (const f of files) set.add(f);
  recordedForOp.delete(opId);
  recordedForOp.set(opId, set);
  if (recordedForOp.size > RECORDED_OPS) recordedForOp.delete(recordedForOp.keys().next().value!);
}

export const captureRollbackPhase: Phase = async (ctx) => {
  try {
    const pending = captureBeforeCall(
      { toolCallId: ctx.tc.id, tool: ctx.tc.name, sessionId: ctx.sessionId, opId: ctx.operationId },
      [...fileToolPaths(ctx), ...shellPaths(ctx)],
    );
    if (pending) ctx.rollback = pending;
  } catch (e) {
    logger.warn(`[rollback] capture threw for ${ctx.tc.name}: ${(e as Error).message}`);
  }
  return CONTINUE;
};

/** After the call: put on record the files it changed, and tell the chat, one
 *  line per call that the request's notice gathers (chat-stream-reducer.js).
 *  A call that failed partway still changed what it changed. */
export function recordFileChanges(ctx: ToolCallContext): void {
  let contract;
  try { contract = recordCapture(ctx.rollback ?? null); }
  catch (e) { logger.warn(`[rollback] record threw for ${ctx.tc.name}: ${(e as Error).message}`); return; }
  if (!contract) return;
  const files = contract.artifacts.flatMap((a) => (a.type === "none" ? [] : [a.original]));
  if (ctx.operationId) noteRecorded(ctx.operationId, files);
  if (files.length === 0 || !ctx.onEvent || !ctx.operationId || !ctx.sessionId) return;
  ctx.onEvent({ type: "file_changes", sessionId: ctx.sessionId, opId: ctx.operationId, files });
}
