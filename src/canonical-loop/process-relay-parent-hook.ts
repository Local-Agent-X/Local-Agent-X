import type { ProcessRelayNotice } from "./process-relay-contract.js";

let handler: ((opId: string) => void) | null = null;

export function setProcessRelayParentHandler(next: ((opId: string) => void) | null): void {
  handler = next;
}

export function notifyProcessRelayParent(notice: ProcessRelayNotice | string): void {
  handler?.(typeof notice === "string" ? notice : notice.opId);
}
