// Public surface for the AriKernel package. Callers (routes/security,
// server/lifecycle, tool-execution/enforce-policy, tests) import from this
// directory.

export { isAriActive } from "./state.js";
export { getAriPresetForSession, HOST_CAPABILITY_MANIFEST } from "./manifest.js";
export { shouldGateInKernel, shouldObserveInKernel, TOOL_CLASS_MAP, GATED_CLASSES } from "./tool-class-map.js";
export { auditKernelCoverage, printKernelCoverageReport } from "./coverage.js";
export type { KernelCoverageReport } from "./coverage.js";
export { ariObserve } from "./observe.js";
export { ariEvaluate } from "./evaluate.js";
export { startAriKernel, stopAriKernel, ariStatus, getFirewallForTest } from "./lifecycle.js";
