/**
 * Which relay records each target has taken: the acknowledgement file beside
 * a relay generation's journal (process-relay-journal.ts). Sealed with the
 * durable-record MAC under its own domain, so a file edited on disk, or one
 * naming a cursor or target its journal never had, is refused rather than
 * read as "already delivered".
 */
import { existsSync, readFileSync } from "node:fs";
import { computeDurableRecordMac, verifyDurableRecordMac } from "../app-runtime/audit-signing.js";
import { writeFileDurably } from "../persistence/durable-directory.js";
import { stableStringify, type ProcessRelayRecord, type ProcessRelayTarget } from "./process-relay-contract.js";

const ACK_DOMAIN = "canonical-process-relay-ack-v1";

interface RelayAckState {
  schemaVersion: 1;
  generationId: string;
  acknowledgements: Record<string, ProcessRelayTarget[]>;
}

interface SealedRelayAckState { state: RelayAckState; mac: string }

/** A generation's acknowledgements by record cursor, checked against its
 *  journal's records. Throws when the file is missing, fails its seal, or
 *  names a cursor or target the journal does not hold. */
export function readRelayAcknowledgements(
  path: string,
  generationId: string,
  records: readonly ProcessRelayRecord[],
): Map<number, Set<ProcessRelayTarget>> {
  const acknowledgements = new Map<number, Set<ProcessRelayTarget>>();
  for (const [cursorText, targets] of Object.entries(readAckState(path, generationId).acknowledgements)) {
    if (!/^[1-9]\d*$/.test(cursorText)) throw new Error("process relay acknowledgement is ambiguous");
    const cursor = Number(cursorText);
    const record = records.find(candidate => candidate.cursor === cursor);
    if (!record || !Number.isSafeInteger(cursor) || targets.some(target => !record.targets.includes(target))) {
      throw new Error("process relay acknowledgement is ambiguous");
    }
    acknowledgements.set(cursor, new Set(targets));
  }
  return acknowledgements;
}

/** Replace a generation's acknowledgement file, sealed. */
export function writeRelayAcknowledgements(
  path: string,
  generationId: string,
  acknowledgements: ReadonlyMap<number, ReadonlySet<ProcessRelayTarget>>,
): void {
  const state: RelayAckState = {
    schemaVersion: 1,
    generationId,
    acknowledgements: Object.fromEntries([...acknowledgements]
      .map(([cursor, targets]) => [String(cursor), [...targets].sort()])),
  };
  const sealed: SealedRelayAckState = { state, mac: computeDurableRecordMac(ACK_DOMAIN, stableStringify(state)) };
  writeFileDurably(path, JSON.stringify(sealed));
}

function readAckState(path: string, generationId: string): RelayAckState {
  if (!existsSync(path)) throw new Error("process relay acknowledgement state is missing");
  const sealed = JSON.parse(readFileSync(path, "utf8")) as Partial<SealedRelayAckState>;
  const state = sealed.state as Partial<RelayAckState> | undefined;
  if (!state || state.schemaVersion !== 1 || state.generationId !== generationId
    || !state.acknowledgements || typeof state.acknowledgements !== "object"
    || typeof sealed.mac !== "string"
    || !verifyDurableRecordMac(ACK_DOMAIN, stableStringify(state), sealed.mac)) {
    throw new Error("process relay acknowledgement integrity check failed");
  }
  for (const targets of Object.values(state.acknowledgements)) {
    if (!Array.isArray(targets) || new Set(targets).size !== targets.length
      || targets.some(target => target !== "canonical-core" && target !== "session-observer" && target !== "browser-render")) {
      throw new Error("invalid process relay acknowledgement target");
    }
  }
  return state as RelayAckState;
}
