import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { opMessagesPath, opTurnPath, opTurnsDir } from "./schema.js";
import type { OpMessageRow, OpTurnRow } from "./types.js";
import type { CanonicalState } from "./types.js";
import type { LearnedOutcome } from "../protocols/learned-effectiveness.js";
import {
  hasMessageCollision,
  isOpMessageRow,
  isOpTurnRow,
  isTurnCommitEnvelope,
} from "./turn-commit-validation.js";
export { isTurnCommitEnvelope } from "./turn-commit-validation.js";

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
  | "after_directory_fsync"
  | "after_publish";

let writeHook: ((point: TurnCommitWritePoint) => void) | null = null;

export function _setTurnCommitWriteHookForTests(
  hook: ((point: TurnCommitWritePoint) => void) | null,
): void {
  writeHook = hook;
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
      if (hasMessageCollision(parsed.messages, readLegacyMessages(opId))) return null;
      return parsed;
    }
    if ((parsed as { schemaVersion?: unknown })?.schemaVersion !== undefined) return null;
    return isOpTurnRow(parsed) && parsed.opId === opId && parsed.turnIdx === turnIdx ? parsed : null;
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
  const tmp = `${target}.${process.pid}-${randomUUID()}.stage`;
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
    fsyncParentDirectory(dir);
    writeHook?.("after_directory_fsync");
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

/** Called only while the current exact lease owns the op lock. Any stage in
 * this namespace then belongs to a dead predecessor; an active writer cannot
 * coexist behind the same lock. */
export function scavengeTurnCommitStages(opId: string): number {
  const dir = opTurnsDir(opId);
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    const current = /^\d+\.json\.(\d+)-[0-9a-f-]+\.stage$/i.exec(name);
    if (current && processAlive(Number(current[1]))) continue;
    if (!current && !/^\d+\.json\.[0-9a-f-]+\.stage$/i.test(name)) continue;
    rmSync(join(dir, name), { force: true });
    removed++;
  }
  return removed;
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

function readLegacyMessages(opId: string): OpMessageRow[] {
  const path = opMessagesPath(opId);
  if (!existsSync(path)) return [];
  const rows: OpMessageRow[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isOpMessageRow(parsed) && parsed.opId === opId) rows.push(parsed);
    } catch { /* invalid legacy tail is handled by its own writer */ }
  }
  return rows;
}

function fsyncParentDirectory(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Windows rejects directory fsync on common filesystems; only its known
    // unsupported-handle error family may degrade to rename durability.
    const windowsUnsupported = process.platform === "win32"
      && ["EACCES", "EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(code ?? "");
    if (!windowsUnsupported) throw error;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* preserve primary failure */ }
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
