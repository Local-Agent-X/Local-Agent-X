import type {
  ProcessRelayKind,
  ProcessRelayNotice,
} from "./process-relay-contract.js";

export type ProcessRelayWriter = (kind: ProcessRelayKind, payload: unknown) => ProcessRelayNotice;

let writer: ProcessRelayWriter | null = null;

export function setProcessRelayOutputWriter(next: ProcessRelayWriter | null): void {
  writer = next;
}

/** Persist before returning. The caller suppresses process-local projection on true. */
export function publishProcessRelayOutput(kind: ProcessRelayKind, payload: unknown): boolean {
  if (!writer) return false;
  writer(kind, payload);
  return true;
}

export function hasProcessRelayOutputWriter(): boolean {
  return writer !== null;
}
