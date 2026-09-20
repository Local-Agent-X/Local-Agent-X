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
  publishedCertificationSelectionHash,
  restorePublishedCertification,
  restorePublishedCertifications,
  type CertificationRunInput,
  type CertificationRestoreDeps,
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
  reprobeLocalModelWindow,
  restoreProjectedLocalRuntime,
  type LocalModelCapabilityProfile,
} from "./cache.js";
export {
  certifiedTargetForModel,
  pickCertifiedLocalClassifierTarget,
  pickLocalClassifierModel,
  isCertifiedLocalClassifierTargetCurrent,
  isEligibleClassifierModel,
  type CertifiedLocalClassifierTarget,
} from "./classifier-model.js";
export {
  ModelProfileSchema,
  KERNEL_POLICY_STRICTNESS,
  KERNEL_POLICY_FLOOR_BY_TIER,
  resolveModelProfile,
  modelProfileTier,
  profileFileName,
  hashProfile,
  _resetModelProfilesForTests,
} from "./model-profile.js";
export type { ModelProfile, ResolvedModelProfile } from "./model-profile.js";
