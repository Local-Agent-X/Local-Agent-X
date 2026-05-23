/**
 * Public surface for the request interception pipeline — re-exports from ./pipeline/.
 *
 * Modules:
 *   - intercept.ts             Pipeline class — orchestrates the 7-step flow
 *   - context.ts               Shared PipelineContext + denial/audit helpers
 *   - protected-actions.ts     Capability-protected toolClass.action lookup
 *   - restricted-gate.ts       Step 1.5a quarantine-mode gating
 *   - run-state-signals.ts     Steps 1.5b + 4.5 security event emission
 *   - capability-tokens.ts     Step 1.5c grant validation + constraint checks
 *   - taint-flow.ts            Steps 2 + 5.5–6.5 taint collection + propagation
 */

export { Pipeline } from "./pipeline/intercept.js";
