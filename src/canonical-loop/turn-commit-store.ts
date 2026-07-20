import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
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
import type { RuntimeRoutingFeedback } from "./types.js";
import {
  hasMessageCollision,
  isLegacyOpTurnRow,
  isOpMessageRow,
  isOpTurnRow,
  isTurnCommitEnvelope,
  projectionMatchesOp,
} from "./turn-commit-validation.js";
export { isTurnCommitEnvelope } from "./turn-commit-validation.js";
import { readOp } from "../ops/op-store.js";
import { getLaxDir } from "../lax-data-dir.js";
import { ensureDurableDirectory, fsyncDirectory } from "../persistence/durable-directory.js";

export interface TurnCommitProjection {
  opType: string;
  task?: string;
  sessionId: string;
  learnedOutcome?: LearnedOutcome;
  routingFeedback?: RuntimeRoutingFeedback;
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

export type LegacyMessageSeedIssue =
  | { kind: "malformed_row"; line: number }
  | { kind: "foreign_op"; line: number }
  | { kind: "duplicate_message_id"; line: number; messageId: string }
  | { kind: "duplicate_position"; line: number; position: string };

export interface LegacyMessageSeedRead {
  rows: OpMessageRow[];
  issues: LegacyMessageSeedIssue[];
}

export class LegacyMessageSeedIntegrityError extends Error {
  constructor(public readonly opId: string, public readonly issues: LegacyMessageSeedIssue[]) {
    super(`legacy message seed integrity failure for ${opId}: ${issues.map((issue) => issue.kind).join(",")}`);
    this.name = "LegacyMessageSeedIntegrityError";
  }
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
  const artifact = readBaseArtifact(opId, turnIdx);
  if (!artifact || !("turn" in artifact)) return artifact;
  return hasMessageCollision(artifact.messages, priorCommittedMessages(opId, turnIdx))
    ? null : artifact;
}

function readBaseArtifact(
  opId: string,
  turnIdx: number,
): TurnCommitEnvelope | OpTurnRow | null {
  const artifact = readStructurallyAuthorizedArtifact(opId, turnIdx);
  if (!artifact || !("turn" in artifact)) return artifact;
  const seeds = readLegacyMessageSeeds(opId);
  return seeds.issues.length || hasMessageCollision(artifact.messages, seeds.rows)
    ? null : artifact;
}

function readStructurallyAuthorizedArtifact(
  opId: string,
  turnIdx: number,
): TurnCommitEnvelope | OpTurnRow | null {
  const path = opTurnPath(opId, turnIdx);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (isTurnCommitEnvelope(parsed)) {
      const op = readOp(opId);
      if (!op || op.id !== opId) return null;
      if (parsed.turn.opId !== opId || parsed.turn.turnIdx !== turnIdx) return null;
      if (!projectionMatchesOp(parsed.projection, op)) return null;
      return parsed;
    }
    if ((parsed as { schemaVersion?: unknown })?.schemaVersion !== undefined) return null;
    return isLegacyOpTurnRow(parsed) && parsed.opId === opId && parsed.turnIdx === turnIdx ? parsed : null;
  } catch {
    return null;
  }
}

function priorCommittedMessages(opId: string, beforeTurnIdx: number): OpMessageRow[] {
  const dir = opTurnsDir(opId);
  if (!existsSync(dir)) return [];
  const messages: OpMessageRow[] = [];
  const indexes = readdirSync(dir).map((name) => /^(\d+)\.json$/.exec(name))
    .filter((match): match is RegExpExecArray => !!match)
    .map((match) => Number(match[1]))
    .filter((turnIdx) => turnIdx < beforeTurnIdx)
    .sort((a, b) => a - b);
  for (const turnIdx of indexes) {
    const artifact = readBaseArtifact(opId, turnIdx);
    if (!artifact || !("turn" in artifact)) continue;
    if (hasMessageCollision(artifact.messages, messages)) continue;
    messages.push(...artifact.messages);
  }
  return messages;
}

export function publishTurnCommit(envelope: TurnCommitEnvelope): boolean {
  const { opId, turnIdx } = envelope.turn;
  ensureDurableDirectory(join(getLaxDir(), "operations", opId));
  const target = opTurnPath(opId, turnIdx);
  if (existsSync(target)) return false;
  const dir = opTurnsDir(opId);
  ensureDurableDirectory(dir);
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
    assertTurnCommitPublicationValid(envelope);
    renameSync(tmp, target);
    published = true;
    fsyncDirectory(dir);
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
  if (!existsSync(target)) return false;
  const artifact = readStructurallyAuthorizedArtifact(opId, turnIdx);
  if (artifact && "turn" in artifact) {
    const seeds = readLegacyMessageSeeds(opId);
    if (seeds.issues.length) throw new LegacyMessageSeedIntegrityError(opId, seeds.issues);
    if (!hasMessageCollision(artifact.messages, seeds.rows)
      && !hasMessageCollision(artifact.messages, priorCommittedMessages(opId, turnIdx))) return false;
  } else if (artifact) {
    return false;
  }
  renameSync(target, `${target}.${randomUUID()}.corrupt`);
  return true;
}

export function committedMessagesFromArtifact(
  artifact: TurnCommitEnvelope | OpTurnRow | null,
): OpMessageRow[] {
  return artifact && isTurnCommitEnvelope(artifact) ? artifact.messages : [];
}

export function readLegacyMessageSeeds(opId: string): LegacyMessageSeedRead {
  const path = opMessagesPath(opId);
  if (!existsSync(path)) return { rows: [], issues: [] };
  const rows: OpMessageRow[] = [];
  const issues: LegacyMessageSeedIssue[] = [];
  const ids = new Set<string>();
  const positions = new Set<string>();
  const lines = readFileSync(path, "utf-8").split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isOpMessageRow(parsed)) {
        issues.push({ kind: "malformed_row", line: index + 1 });
        continue;
      }
      if (parsed.opId !== opId) {
        issues.push({ kind: "foreign_op", line: index + 1 });
        continue;
      }
      const position = `${parsed.turnIdx}:${parsed.seqInTurn}`;
      if (ids.has(parsed.messageId)) {
        issues.push({ kind: "duplicate_message_id", line: index + 1, messageId: parsed.messageId });
      }
      if (positions.has(position)) {
        issues.push({ kind: "duplicate_position", line: index + 1, position });
      }
      ids.add(parsed.messageId);
      positions.add(position);
      rows.push(parsed);
    } catch { issues.push({ kind: "malformed_row", line: index + 1 }); }
  }
  return { rows, issues };
}

function assertTurnCommitPublicationValid(envelope: TurnCommitEnvelope): void {
  const op = readOp(envelope.turn.opId);
  const seeds = readLegacyMessageSeeds(envelope.turn.opId);
  if (seeds.issues.length) throw new LegacyMessageSeedIntegrityError(envelope.turn.opId, seeds.issues);
  if (!op || !projectionMatchesOp(envelope.projection, op)
    || hasMessageCollision(envelope.messages, seeds.rows)
    || hasMessageCollision(envelope.messages, priorCommittedMessages(envelope.turn.opId, envelope.turn.turnIdx))) {
    throw new Error(`turn commit message collision or invalid authority for ${envelope.turn.opId}#${envelope.turn.turnIdx}`);
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
