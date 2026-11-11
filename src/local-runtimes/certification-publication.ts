// Which certifications are published in this process: the per-snapshot proof
// a background-model choice reads (hasPublishedCertification) without probing a
// runtime. Certifying publishes or withdraws one; a restore republishes saved
// evidence (certification-runner.ts).

import { certificationSelectionFingerprint } from "./certification-fingerprint.js";
import { LOCAL_MODEL_CERTIFICATION_SCENARIOS } from "./certification-scenarios.js";
import { LOCAL_MODEL_CERTIFICATION_CONTRACT } from "./certification-types.js";
import type { CertificationContract, LocalModelCertification } from "./certification-types.js";
import type { LocalModel, LocalRuntimeInfo } from "./types.js";

interface PublishedCertification {
  certificationHash: string;
  selectionHash: string;
}
const publishedCertifications = new WeakMap<
  LocalRuntimeInfo,
  WeakMap<LocalModel, PublishedCertification>
>();

export function unpublishCertification(runtime: LocalRuntimeInfo, modelId: string): void {
  const model = runtime.models.find((candidate) => candidate.id === modelId);
  if (model) publishedCertifications.get(runtime)?.delete(model);
}

export function passedCertification(result: LocalModelCertification): boolean {
  return result.fingerprint.reusable
    && result.passedCount === LOCAL_MODEL_CERTIFICATION_SCENARIOS.length
    && LOCAL_MODEL_CERTIFICATION_CONTRACT.scenarios.every((id) => result.scenarios[id]?.passed);
}

export function publishCertification(runtime: LocalRuntimeInfo, modelId: string, result: LocalModelCertification): void {
  if (!passedCertification(result)) return;
  const model = runtime.models.find((candidate) => candidate.id === modelId);
  if (!model) return;
  let published = publishedCertifications.get(runtime);
  if (!published) {
    published = new WeakMap<LocalModel, PublishedCertification>();
    publishedCertifications.set(runtime, published);
  }
  published.set(model, {
    certificationHash: result.fingerprint.hash,
    selectionHash: certificationSelectionFingerprint(runtime, modelId, result.fingerprint.hash),
  });
}

export function canCarryPublishedSelection(
  previousRuntime: LocalRuntimeInfo,
  previousModel: LocalModel,
  runtime: LocalRuntimeInfo,
  model: LocalModel,
): boolean {
  const published = publishedCertifications.get(previousRuntime)?.get(previousModel);
  if (!published) return false;
  return published.selectionHash === certificationSelectionFingerprint(
    previousRuntime,
    previousModel.id,
    published.certificationHash,
  ) && published.selectionHash === certificationSelectionFingerprint(
    runtime,
    model.id,
    published.certificationHash,
  );
}

/**
 * A process-local proof that this exact discovery snapshot passed the current
 * certification contract. It deliberately cannot revive persisted evidence:
 * choosing a background model must never probe a runtime on its hot path.
 */
export function hasPublishedCertification(runtime: LocalRuntimeInfo, model: LocalModel, contract: CertificationContract = LOCAL_MODEL_CERTIFICATION_CONTRACT): boolean {
  return publishedCertificationSelectionHash(runtime, model, contract) !== null;
}
export function publishedCertificationSelectionHash(runtime: LocalRuntimeInfo, model: LocalModel, contract: CertificationContract = LOCAL_MODEL_CERTIFICATION_CONTRACT): string | null {
  const published = publishedCertifications.get(runtime)?.get(model);
  if (!published) return null;
  const current = certificationSelectionFingerprint(
    runtime,
    model.id,
    published.certificationHash,
    contract,
  );
  return current === published.selectionHash ? current : null;
}
