/**
 * Per-op instruction ledger.
 *
 * Records the user's explicit run constraints for one op — capability-class
 * prohibitions ("don't hit the network"), end-of-op obligations ("commit when
 * done"), and the literal phrases they were parsed from — keyed by opId so
 * BOTH the middleware layer and the pre-dispatch layer read the same record.
 * Deliberately standalone: no imports from canonical-loop/middlewares or
 * src/tools, so either layer can depend on it without cycles.
 *
 * FAIL-OPEN: every accessor returns the permissive default (false / empty /
 * undefined) when no ledger was set for the op. An absent or empty ledger
 * must never block or suppress anything.
 *
 * Entries are dropped via `clearOpLedger` from the op-terminal cleanup in
 * state-machine.ts (beside clearMiddlewareStateForOp) so the registry doesn't
 * grow unbounded across the process lifetime.
 */
import type { CapabilityClass } from "../../tool-registry.js";

/** Something the user asked to happen at op end. */
export type Obligation = { kind: "commit-when-done" };

export interface InstructionLedger {
  /** Capability classes the user forbade for this op. */
  prohibitions: CapabilityClass[];
  /** End-of-op obligations the user stated. */
  obligations: Obligation[];
  /** The literal user phrases the constraints were parsed from. */
  phrases: string[];
}

const LEDGERS = new Map<string, InstructionLedger>();

export function setOpLedger(opId: string, ledger: InstructionLedger): void {
  LEDGERS.set(opId, ledger);
}

/** The raw ledger, or undefined when none was recorded for the op. */
export function getOpLedger(opId: string): InstructionLedger | undefined {
  return LEDGERS.get(opId);
}

/** Idempotent; safe to call repeatedly and for ops that never had a ledger. */
export function clearOpLedger(opId: string): void {
  LEDGERS.delete(opId);
}

/** False (permissive) unless the op's ledger explicitly prohibits `cls`. */
export function opForbidsCapability(opId: string, cls: CapabilityClass): boolean {
  return LEDGERS.get(opId)?.prohibitions.includes(cls) ?? false;
}

/** Empty (permissive) when no ledger is set. */
export function opObligations(opId: string): Obligation[] {
  return LEDGERS.get(opId)?.obligations ?? [];
}

/** True only when the op's ledger records at least one constraint or phrase. */
export function opHasConstraints(opId: string): boolean {
  const l = LEDGERS.get(opId);
  if (!l) return false;
  return l.prohibitions.length > 0 || l.obligations.length > 0 || l.phrases.length > 0;
}

/** Test-only: drop every op's ledger. Used by test harnesses between cases. */
export function _resetOpLedgers(): void {
  LEDGERS.clear();
}
