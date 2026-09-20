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
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { opTurnsDir, opTurnTracePath } from "./schema.js";
import type { TurnTrace } from "./adapter-contract.js";
import { resolveModelProfile } from "../local-runtimes/model-profile.js";
import { createLogger } from "../logger.js";

const logger = createLogger("canonical-loop.turn-trace");

export interface StoredTurnTrace extends TurnTrace {
  schemaVersion: 1;
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
    const stored: StoredTurnTrace = {
      schemaVersion: 1, runId: resolveRunId(), opId, turnIdx,
      profileId: profile?.profileId ?? null, profileHash: profile?.profileHash ?? null,
      ...trace,
    };
    const tmp = `${target}.${process.pid}-${randomUUID()}.stage`;
    writeFileSync(tmp, gzipSync(Buffer.from(JSON.stringify(stored))), { mode: 0o600 });
    renameSync(tmp, target);
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

export function readTurnTrace(opId: string, turnIdx: number): StoredTurnTrace | null {
  const path = opTurnTracePath(opId, turnIdx);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(gunzipSync(readFileSync(path)).toString("utf8")) as StoredTurnTrace;
  } catch {
    return null;
  }
}
