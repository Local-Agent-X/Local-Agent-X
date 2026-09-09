/**
 * canonical-loop public sub-barrel: the per-op instruction ledger.
 *
 * The ledger decides what a user's own instructions forbid or oblige for the
 * rest of an op. Callers outside canonical-loop that build prompts or run
 * background agents (self-edit, background-jobs) need to reason about the same
 * constraints the loop enforces, and canonical-loop imports several of those
 * modules back — so they cannot reach the heavy index barrel without minting a
 * cycle.
 *
 * Test-only reset helpers are deliberately NOT here; they live in
 * public/test-surface.ts, which the interface seal forbids production code
 * from importing.
 */
export { phraseGate, extractConstraints } from "../instruction-ledger/extract.js";
export { createInstructionLedgerMiddleware } from "../middlewares/instruction-ledger.js";
export {
	getOpLedger,
	setOpLedger,
	clearOpLedger,
	opForbidsCapability,
	opObligations,
	opHasConstraints,
} from "../instruction-ledger/index.js";
export type { InstructionLedger, Obligation } from "../instruction-ledger/index.js";
