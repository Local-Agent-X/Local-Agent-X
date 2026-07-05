/** Public surface of the per-op instruction ledger (see ledger.ts). */
export {
  setOpLedger,
  getOpLedger,
  clearOpLedger,
  opForbidsCapability,
  opObligations,
  opHasConstraints,
} from "./ledger.js";
export type { InstructionLedger, Obligation } from "./ledger.js";
