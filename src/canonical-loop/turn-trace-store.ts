/**
 * Per-turn trace artifact: `op-turns/<idx>.trace.json.gz`, beside the turn
 * record the commit path publishes.
 *
 * The turn record holds the parsed calls, result hashes and timings; nothing
 * held the prompt the model was actually sent, the raw answer before
 * extraction, or its thinking, so a run could not be replayed as the model
 * saw it (Phase 0 audit, section 10). This artifact is that record. It is
 * evidence, not state: nothing in the loop reads it back, it is written after
 * the turn's durable commit, and a failure here is logged and dropped rather
 * than failing the turn. Stamped with a run id so an eval can group the ops
 * of one run: `LAX_RUN_ID` when a rig sets it, else one id per process boot.
 *
 * `LAX_TRACE_TURNS=0` turns the artifact off.
 *
 * Each step re-sends the whole history, so a trace keeps only the rows that
 * changed: when the previous trace this process wrote for the op shares a
 * prefix of rows with this one, those rows are named (`messagesFrom`) instead
 * of stored again. A 72-step Opus run sent 8.2M prompt tokens in all; stored
 * whole that is megabytes per run, stored this way about what one step holds.
 * readTurnTrace puts the history back together; `scripts/lax-trace.mjs`
 * (readTraceFile) does the same for the scripts that read traces directly.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { opTurnsDir, opTurnTracePath } from "./schema.js";
import type { TurnTrace } from "./adapter-contract.js";
import { resolveModelProfile } from "../local-runtimes/model-profile.js";
import { createLogger } from "../logger.js";

const logger = createLogger("canonical-loop.turn-trace");

/** Where a stored trace's history starts: its first `count` rows are the
 *  first `count` rows of turn `turnIdx`'s trace, and `messages` holds the rest. */
export interface MessagesFrom { turnIdx: number; count: number }

export interface StoredTurnTrace extends TurnTrace {
  /** 2: `request.messages` may be the rows after `request.messagesFrom`. */
  schemaVersion: 2;
  request: TurnTrace["request"] & { messagesFrom?: MessagesFrom };
  runId: string;
  opId: string;
  turnIdx: number;
  /** The declared profile the model ran under (config/model-profiles), or
   *  null when it has none — so an experiment's traces name their profile. */
  profileId: string | null;
  profileHash: string | null;
}

const bootRunId = `run-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;

/** The run every trace written by this process belongs to. */
export function resolveRunId(): string {
  return process.env.LAX_RUN_ID?.trim() || bootRunId;
}

export function turnTracingEnabled(): boolean {
  return process.env.LAX_TRACE_TURNS !== "0";
}

/** The history rows, one JSON string each, of the last trace this process
 *  wrote per op. Only a trace that reached disk is remembered, so a stored
 *  `messagesFrom` always names a trace that exists. */
const lastWritten = new Map<string, { turnIdx: number; rows: string[] }>();
const MAX_REMEMBERED_OPS = 16;

function remember(opId: string, turnIdx: number, rows: string[]): void {
  lastWritten.delete(opId);
  lastWritten.set(opId, { turnIdx, rows });
  if (lastWritten.size > MAX_REMEMBERED_OPS) lastWritten.delete(lastWritten.keys().next().value as string);
}

function sharedRows(a: string[], b: string[]): number {
  let k = 0;
  while (k < a.length && k < b.length && a[k] === b[k]) k++;
  return k;
}

/** Write the artifact once; a second publish for the same turn is a no-op.
 *  Never throws: the turn is already committed when this runs. */
export function publishTurnTrace(opId: string, turnIdx: number, trace: TurnTrace): boolean {
  if (!turnTracingEnabled()) return false;
  try {
    const target = opTurnTracePath(opId, turnIdx);
    if (existsSync(target)) return false;
    const dir = opTurnsDir(opId);
    mkdirSync(dir, { recursive: true });
    const profile = profileFor(trace.model);
    const rows = trace.request.messages.map((m) => JSON.stringify(m));
    const prev = lastWritten.get(opId);
    const shared = prev && prev.turnIdx < turnIdx ? sharedRows(prev.rows, rows) : 0;
    const request: StoredTurnTrace["request"] = prev && shared > 0
      ? { ...trace.request, messages: trace.request.messages.slice(shared), messagesFrom: { turnIdx: prev.turnIdx, count: shared } }
      : trace.request;
    const stored: StoredTurnTrace = {
      schemaVersion: 2, runId: resolveRunId(), opId, turnIdx,
      profileId: profile?.profileId ?? null, profileHash: profile?.profileHash ?? null,
      ...trace,
      request,
    };
    const tmp = `${target}.${process.pid}-${randomUUID()}.stage`;
    writeFileSync(tmp, gzipSync(Buffer.from(JSON.stringify(stored))), { mode: 0o600 });
    renameSync(tmp, target);
    remember(opId, turnIdx, rows);
    return true;
  } catch (e) {
    logger.warn(`trace for ${opId}#${turnIdx} not written: ${(e as Error).message}`);
    return false;
  }
}

function profileFor(model: string): { profileId: string; profileHash: string } | null {
  try {
    return resolveModelProfile(model);
  } catch {
    return null;
  }
}

/** A turn's trace with its whole history: rows named by `messagesFrom` are
 *  read back from the trace that holds them. When that trace is gone the
 *  stored rows are returned as they are, `messagesFrom` still set, so a
 *  reader can tell the history is partial. */
export function readTurnTrace(opId: string, turnIdx: number): StoredTurnTrace | null {
  const stored = readStoredTrace(opId, turnIdx);
  const from = stored?.request.messagesFrom;
  if (!stored || !from || from.turnIdx >= turnIdx) return stored;
  const base = readTurnTrace(opId, from.turnIdx);
  if (!base || base.request.messagesFrom || base.request.messages.length < from.count) return stored;
  const request = { ...stored.request, messages: [...base.request.messages.slice(0, from.count), ...stored.request.messages] };
  delete request.messagesFrom;
  return { ...stored, request };
}

function readStoredTrace(opId: string, turnIdx: number): StoredTurnTrace | null {
  const path = opTurnTracePath(opId, turnIdx);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(gunzipSync(readFileSync(path)).toString("utf8")) as StoredTurnTrace;
  } catch {
    return null;
  }
}
