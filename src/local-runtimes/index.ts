/** Public surface of the canonical local-runtime seam. */
export type {
  LocalModel,
  LocalRuntimeEndpoint,
  LocalRuntimeInfo,
  LocalRuntimeKind,
  LocalRuntimeProbe,
} from "./types.js";
export { admitEndpoint, endpointHostPort } from "./admission.js";
export { LOCAL_RUNTIME_PROBES, probeFor } from "./probes.js";
export {
  candidateEndpoints,
  manualAllowlist,
  manualRuntimeEntries,
  type ManualRuntimeEntry,
} from "./endpoints.js";
export { discoverLocalRuntimes } from "./discovery.js";
export {
  lmStudioAutoStartedAt,
  maybeAutostartLmStudio,
  type LmStudioAutostartDeps,
} from "./lmstudio-autostart.js";
export {
  getLocalContextWindow,
  getLocalModel,
  getLocalRuntimeById,
  getLocalRuntimes,
  getRuntimeForModel,
  invalidateLocalRuntimes,
  localRuntimesStale,
  refreshLocalRuntimes,
} from "./cache.js";
