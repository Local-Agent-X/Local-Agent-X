// Which committed turn messages an op's history accepts, scanned once per read.

import { existsSync, readdirSync } from "node:fs";
import { opTurnsDir } from "./schema.js";
import type { OpMessageRow, OpTurnRow } from "./types.js";
import type { TurnCommitEnvelope } from "./turn-commit-store.js";
import { messagePosition } from "./turn-commit-validation.js";

/**
 * One ascending pass over the op's turn artifacts, recording the turn that
 * first accepted each message id and position. "Does turn N collide with an
 * earlier accepted turn" is then a lookup, not a rebuild. Rebuilding the
 * prior list per turn — with fresh id/position sets per prior turn — was
 * cubic in turns once history rebuilds ran every turn: a 180-turn muse op
 * blocked the event loop for 5s, then 10s, then 19s (2026-09-17).
 */
export interface AcceptedScan {
  indexes: number[];
  next: number;
  idTurn: Map<string, number>;
  positionTurn: Map<string, number>;
}

/** Extend `scan` (created on first use) through every turn below `beforeTurnIdx`. */
export function extendAcceptedScan(
  existing: AcceptedScan | undefined,
  opId: string,
  beforeTurnIdx: number,
  readBase: (turnIdx: number) => TurnCommitEnvelope | OpTurnRow | null,
): AcceptedScan {
  let scan = existing;
  if (!scan) {
    const dir = opTurnsDir(opId);
    const indexes = existsSync(dir)
      ? readdirSync(dir).map((name) => /^(\d+)\.json$/.exec(name))
        .filter((match): match is RegExpExecArray => !!match)
        .map((match) => Number(match[1]))
        .sort((a, b) => a - b)
      : [];
    scan = { indexes, next: 0, idTurn: new Map(), positionTurn: new Map() };
  }
  while (scan.next < scan.indexes.length && scan.indexes[scan.next] < beforeTurnIdx) {
    const turnIdx = scan.indexes[scan.next++];
    const artifact = readBase(turnIdx);
    if (!artifact || !("turn" in artifact)) continue;
    if (collidesWithAcceptedBefore(artifact.messages, turnIdx, scan)) continue;
    for (const row of artifact.messages) {
      if (!scan.idTurn.has(row.messageId)) scan.idTurn.set(row.messageId, turnIdx);
      const position = messagePosition(row);
      if (!scan.positionTurn.has(position)) scan.positionTurn.set(position, turnIdx);
    }
  }
  return scan;
}

export function collidesWithAcceptedBefore(messages: readonly OpMessageRow[], turnIdx: number, scan: AcceptedScan): boolean {
  return messages.some((row) =>
    (scan.idTurn.get(row.messageId) ?? Infinity) < turnIdx
    || (scan.positionTurn.get(messagePosition(row)) ?? Infinity) < turnIdx);
}
