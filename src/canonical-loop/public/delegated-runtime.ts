/**
 * canonical-loop public sub-barrel: delegated-op runtime wiring.
 *
 * The precise symbol set the delegated-workers seam (ops/tools/shared.ts)
 * consumes to pin, seal, and install a delegated worker's runtime. ops/ sits
 * inside the import SCC that canonical-loop itself reaches, so it cannot
 * import the heavy index barrel without minting cycles — it uses this light
 * pass-through barrel instead. Re-export exactly what that seam needs; the
 * source modules' other exports stay internal.
 */
export { registerAdapterForOp } from "../runtime.js";
export { createProviderAdapterFactory, resolveProviderRuntime } from "../provider-adapter-factory.js";
export { sealDelegatedRuntime } from "../runtime-integrity.js";
// Promoted for the interface seal (ops/tools/shared.ts previously deep-imported
// agent-runner/runtime-surface.js): building the durable runtime surface and
// first-run in-process tool-runtime installation. runtime-surface's other
// exports (rehydrateAgentRuntimeSurface, ...) remain internal.
export { buildAgentRuntimeSurface, installOpToolRuntime } from "../agent-runner/runtime-surface.js";
