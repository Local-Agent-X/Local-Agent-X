// Public surface for the AriKernel package. Legacy `src/ari-kernel.ts`
// re-exports from here so existing callers (routes/security,
// server/lifecycle, tool-execution/enforce-policy, tests) don't need to
// update import paths.

export { isAriActive } from "./state.js";
export { getAriPresetForSession, HOST_CAPABILITY_MANIFEST } from "./manifest.js";
export { shouldGateInKernel, shouldObserveInKernel, TOOL_CLASS_MAP, GATED_CLASSES, TOOL_AUTONOMY_RISK, classifyAutonomy } from "./tool-class-map.js";
export type { AutonomyRisk } from "./tool-class-map.js";
export { auditKernelCoverage, printKernelCoverageReport, auditAutonomyCoverage } from "./coverage.js";
export type { KernelCoverageReport } from "./coverage.js";
export { ariObserve } from "./observe.js";
export { ariEvaluate } from "./evaluate.js";
export { startAriKernel, stopAriKernel, ariStatus, getFirewallForTest } from "./lifecycle.js";
