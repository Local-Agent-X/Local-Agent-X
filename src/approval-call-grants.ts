/**
 * One-shot grants: the user's yes to ONE exact call, given away from the
 * call's own card (the inbox's Approve on a call an unattended run parked,
 * src/inbox/approvals.ts). The ApprovalManager holds them beside its other
 * approval state, so there is one approval store. The first gate that would
 * otherwise park, refuse or prompt for that exact call consumes it
 * (tool-execution/deferred-call.ts `takeUserGrant`, and
 * `requestApprovalDetailed` for any card raised for it), alwaysAsk ones
 * included: the user approved that exact call. The giver revokes the grant
 * once its dispatch returns, so a grant no gate needed never outlives it.
 *
 * Keyed by `exactKey` over the model's arguments only: the dispatcher adds
 * `_`-prefixed keys of its own (`_sessionId`, ...) that the parked record
 * never carried.
 */

import { exactKey } from "./approval-decision.js";

function keyOf(sessionId: string, toolName: string, args: Record<string, unknown>): string {
  const modelArgs = Object.fromEntries(Object.entries(args).filter(([name]) => !name.startsWith("_")));
  return exactKey(sessionId, toolName, modelArgs);
}

export class CallGrants {
  private grants = new Map<string, string>();
  private nextId = 1;

  /** Grant one run of this exact call in this session; returns the grant id. */
  grant(sessionId: string, toolName: string, args: Record<string, unknown>): string {
    const id = `grant-${this.nextId++}-${Date.now()}`;
    this.grants.set(keyOf(sessionId, toolName, args), id);
    return id;
  }

  /** Consume the grant for this exact call, if one is held. */
  take(sessionId: string, toolName: string, args: Record<string, unknown>): string | null {
    const key = keyOf(sessionId, toolName, args);
    const id = this.grants.get(key);
    if (id === undefined) return null;
    this.grants.delete(key);
    return id;
  }

  /** Drop a grant whether or not it was consumed. */
  revoke(id: string): void {
    for (const [key, held] of this.grants) if (held === id) this.grants.delete(key);
  }

  size(): number { return this.grants.size; }
}
