/**
 * canonical-loop public sub-barrel: instruction-ledger / enforced-plan-mode
 * surface.
 *
 * WHY THIS EXISTS (and isn't just index.ts): the consumers of this surface —
 * tool-execution/pre-dispatch, chat-ws/message-router, tools/plan-tools — sit
 * inside canonical-loop's own runtime import orbit (index.js transitively
 * reaches tool-execution via chat-tool-dispatcher → tool-executor, and
 * chat-ws via adapters → config → manifest-generator). Pointing them at the
 * heavy index barrel would mint import cycles. This barrel imports ONLY the
 * instruction-ledger internals, preserving the exact reachability those
 * consumers had before the module boundary was sealed.
 *
 * index.ts re-exports this barrel, so the symbols are also part of the
 * front-door API for out-of-orbit callers.
 */
export {
	setOpLedger,
	clearOpLedger,
	getOpLedger,
	opForbidsCapability,
	opObligations,
	opHasConstraints,
	setEnforcedPlanMode,
	isEnforcedPlanMode,
	planModeForbidsCapability,
	capabilityForbiddenForOp,
} from "../instruction-ledger/index.js";
export type { InstructionLedger, Obligation } from "../instruction-ledger/index.js";

// Test-only reset helpers (underscore marks them internal; exported for
// colocated src/ tests, which the interface seal also covers).
export { _resetOpLedgers } from "../instruction-ledger/ledger.js";
export { _resetEnforcedPlanMode } from "../instruction-ledger/plan-mode.js";
