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
import { isAbsolute, join, resolve } from "node:path";
import { captureBeforeCall, recordCapture, type CaptureKeep, type CapturePath } from "../autonomy/rollback.js";
import { isCredentialShapedFile } from "../data-lineage/paths.js";
import { shellDeleteTargets } from "../security/layer/shell-delete-targets.js";
import { commandsBashRuns } from "../security/layer/shell-source-text.js";
import { callPaths, shellCommandOf } from "../tool-registry.js";
import { resolveAgentPath } from "../workspace/paths.js";
import { workspaceRoot } from "../config.js";
import { createLogger } from "../logger.js";
import { shellCreateTargets, shellNamedPaths } from "./create-target-path.js";
import { cwdOf } from "./internal-args.js";
import { currentHumanText, userNamedFile } from "./unnamed-delete-gate.js";
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

/** The files this call deletes, resolved: the delete tool's path, and every
 *  target a shell command removes (the same reading the un-named delete floor
 *  uses), relative ones placed in the folder the shell runs in. */
function deletePaths(ctx: ToolCallContext): Set<string> {
  const out = new Set<string>();
  for (const p of callPaths(ctx.tc.name, ctx.args).deletes) {
    try { out.add(pathKey(resolveAgentPath(p, ctx.sessionId))); } catch { /* unreachable path: the gate refused it */ }
  }
  const command = shellCommandOf(ctx.tc.name, ctx.args);
  if (command) {
    const cwd = cwdOf(ctx.args) || workspaceRoot();
    for (const t of commandsBashRuns(command).flatMap(shellDeleteTargets)) out.add(pathKey(isAbsolute(t) ? t : join(cwd, t)));
  }
  return out;
}

/** One spelling per file, so a shell's forward slashes meet a tool's resolved path. */
const pathKey = (p: string): string => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));

/** How each captured file's bytes are kept (autonomy/rollback.ts CaptureKeep).
 *  A credential file — by its path or its contents, the egress guard's own
 *  judgment (data-lineage/paths.ts isCredentialShapedFile) — is never copied
 *  aside in plaintext: deleted by name at the user's word, nothing is kept
 *  (`final`); changed or deleted by the agent on its own, the copy is sealed
 *  and short-lived (`seal`). Peter, 2026-11-08, after a downloaded key's
 *  private key sat in the rollback store for hours after its delete. */
function keepFor(ctx: ToolCallContext, path: string, deletes: ReadonlySet<string>, humanText: string): CaptureKeep {
  if (!isCredentialShapedFile(path)) return "copy";
  return deletes.has(pathKey(path)) && userNamedFile(humanText, path) ? "final" : "seal";
}

function capturePaths(ctx: ToolCallContext): CapturePath[] {
  const paths = [...new Set([...fileToolPaths(ctx), ...shellPaths(ctx)])];
  if (paths.length === 0) return [];
  const deletes = deletePaths(ctx);
  const humanText = currentHumanText(ctx.priorMessages);
  return paths.map((path) => {
    const keep = keepFor(ctx, path, deletes, humanText);
    return keep === "copy" ? path : { path, keep };
  });
}

export const captureRollbackPhase: Phase = async (ctx) => {
  try {
    const pending = captureBeforeCall(
      { toolCallId: ctx.tc.id, tool: ctx.tc.name, sessionId: ctx.sessionId, opId: ctx.operationId },
      capturePaths(ctx),
    );
    if (pending) ctx.rollback = pending;
  } catch (e) {
    logger.warn(`[rollback] capture threw for ${ctx.tc.name}: ${(e as Error).message}`);
  }
  return CONTINUE;
};

/** After the call: put on record the files it changed, and tell the chat, one
 *  line per call that the request's notice gathers (chat-stream-reducer.js).
 *  A call that failed partway still changed what it changed. A `final` delete
 *  is listed among the files and named in `final`, so the notice can say that
 *  one is gone for good. */
export function recordFileChanges(ctx: ToolCallContext): void {
  let contract;
  try { contract = recordCapture(ctx.rollback ?? null); }
  catch (e) { logger.warn(`[rollback] record threw for ${ctx.tc.name}: ${(e as Error).message}`); return; }
  if (!contract) return;
  const files = contract.artifacts.flatMap((a) => (a.type === "none" ? [] : [a.original]));
  const final = contract.artifacts.flatMap((a) => (a.type === "final" ? [a.original] : []));
  if (ctx.operationId) noteRecorded(ctx.operationId, files);
  if (files.length === 0 || !ctx.onEvent || !ctx.operationId || !ctx.sessionId) return;
  ctx.onEvent({ type: "file_changes", sessionId: ctx.sessionId, opId: ctx.operationId, files, ...(final.length > 0 ? { final } : {}) });
}
