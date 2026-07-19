import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { opTurnPath, opTurnsDir } from "./schema.js";
import type { OpMessageRow, OpTurnRow } from "./types.js";
import type { CanonicalState } from "./types.js";
import type { LearnedOutcome } from "../protocols/learned-effectiveness.js";

export interface TurnCommitProjection {
  opType: string;
  task?: string;
  sessionId: string;
  learnedOutcome?: LearnedOutcome;
  learningSessionId?: string;
  redirectInstructionId?: string;
  redirectText?: string;
  appUrl?: string;
  stateBefore?: CanonicalState;
}

export interface TurnCommitEnvelope {
  schemaVersion: 1;
  turn: OpTurnRow;
  messages: OpMessageRow[];
  projection: TurnCommitProjection;
}

export type TurnCommitWritePoint =
  | "before_stage_open"
  | "after_stage_write"
  | "after_stage_fsync"
  | "before_publish"
  | "after_publish";

let writeHook: ((point: TurnCommitWritePoint) => void) | null = null;

export function _setTurnCommitWriteHookForTests(
  hook: ((point: TurnCommitWritePoint) => void) | null,
): void {
  writeHook = hook;
}

export function isTurnCommitEnvelope(value: unknown): value is TurnCommitEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const envelope = value as Partial<TurnCommitEnvelope>;
  return envelope.schemaVersion === 1
    && !!envelope.turn
    && Array.isArray(envelope.messages)
    && !!envelope.projection;
}

export function readTurnArtifact(
  opId: string,
  turnIdx: number,
): TurnCommitEnvelope | OpTurnRow | null {
  const path = opTurnPath(opId, turnIdx);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (isTurnCommitEnvelope(parsed)) {
      if (parsed.turn.opId !== opId || parsed.turn.turnIdx !== turnIdx) return null;
      if (parsed.messages.some((row) => row.opId !== opId || row.turnIdx !== turnIdx)) return null;
      return parsed;
    }
    const row = parsed as Partial<OpTurnRow>;
    return row.opId === opId && row.turnIdx === turnIdx ? row as OpTurnRow : null;
  } catch {
    return null;
  }
}

export function publishTurnCommit(envelope: TurnCommitEnvelope): boolean {
  const { opId, turnIdx } = envelope.turn;
  const target = opTurnPath(opId, turnIdx);
  if (existsSync(target)) return false;
  const dir = opTurnsDir(opId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${target}.${randomUUID()}.stage`;
  let fd: number | null = null;
  let published = false;
  try {
    writeHook?.("before_stage_open");
    fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    const bytes = Buffer.from(JSON.stringify(envelope));
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset, null);
      if (written <= 0) throw new Error("turn commit stage write made no progress");
      offset += written;
    }
    writeHook?.("after_stage_write");
    fsyncSync(fd);
    writeHook?.("after_stage_fsync");
    closeSync(fd);
    fd = null;
    writeHook?.("before_publish");
    renameSync(tmp, target);
    published = true;
    writeHook?.("after_publish");
    return true;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* preserve the primary failure */ }
    }
    if (!published) {
      try { unlinkSync(tmp); } catch { /* no staged file */ }
    }
  }
}

/** Move a corrupt final-name artifact out of the authoritative namespace so
 * the same turn can be safely re-driven. Valid artifacts are never moved. */
export function quarantineInvalidTurnArtifact(opId: string, turnIdx: number): boolean {
  const target = opTurnPath(opId, turnIdx);
  if (!existsSync(target) || readTurnArtifact(opId, turnIdx)) return false;
  renameSync(target, `${target}.${randomUUID()}.corrupt`);
  return true;
}

export function committedMessagesFromArtifact(
  artifact: TurnCommitEnvelope | OpTurnRow | null,
): OpMessageRow[] {
  return artifact && isTurnCommitEnvelope(artifact) ? artifact.messages : [];
}
