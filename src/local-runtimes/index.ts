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
  certifyLocalModel,
  hasPublishedCertification,
  type CertificationRunInput,
  type CertificationRunnerDeps,
} from "./certification-runner.js";
export { LocalCertificationStore } from "./certification-store.js";
export type {
  CertificationFailure,
  CertificationContract,
  CertificationFingerprint,
  CertificationIdentity,
  CertificationScenarioId,
  CertificationScenarioResult,
  CertificationTransport,
  LocalModelCertification,
} from "./certification-types.js";
export {
  lmStudioAutoStartedAt,
  maybeAutostartLmStudio,
  type LmStudioAutostartDeps,
} from "./lmstudio-autostart.js";
export {
  getLocalContextWindow,
  getLocalModel,
  getLocalModelCapabilityProfile,
  getLocalRuntimeById,
  getLocalRuntimes,
  getRuntimeForModel,
  invalidateLocalRuntimes,
  localRuntimesStale,
  refreshLocalRuntimes,
  type LocalModelCapabilityProfile,
} from "./cache.js";
export {
  pickCertifiedLocalClassifierModel,
  pickLocalClassifierModel,
  isEligibleClassifierModel,
} from "./classifier-model.js";
