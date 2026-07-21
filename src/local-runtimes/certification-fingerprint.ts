import { createHash } from "node:crypto";
import {
  LOCAL_MODEL_CERTIFICATION_CONTRACT,
  type CertificationContract,
  type CertificationFingerprint,
  type CertificationIdentity,
} from "./certification-types.js";
import type { LocalRuntimeInfo } from "./types.js";

function hash(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function certificationContractFingerprint(contract: CertificationContract): string {
  return hash([String(contract.version), ...contract.scenarios]);
}

export function certificationSelectionFingerprint(
  runtime: LocalRuntimeInfo,
  model: string,
  certificationHash: string,
  contract: CertificationContract = LOCAL_MODEL_CERTIFICATION_CONTRACT,
): string {
  const localModel = runtime.models.find((candidate) => candidate.id === model);
  const runtimeIdHash = hash([runtime.id]);
  const endpointHash = hash([runtime.endpoint.baseUrl.replace(/\/+$/, "")]);
  const chatBaseHash = hash([runtime.chatBaseUrl.replace(/\/+$/, "")]);
  const modelHash = hash([model]);
  const kindHash = hash([runtime.kind]);
  const contextHash = hash([String(localModel?.contextWindow ?? "unknown")]);
  const toolsHash = hash([String(localModel?.tools ?? "unknown")]);
  return hash([
    certificationHash,
    certificationContractFingerprint(contract),
    runtimeIdHash,
    endpointHash,
    chatBaseHash,
    modelHash,
    kindHash,
    contextHash,
    toolsHash,
  ]);
}

export function certificationFingerprint(
  runtime: LocalRuntimeInfo,
  model: string,
  identity: CertificationIdentity,
  contract: CertificationContract = LOCAL_MODEL_CERTIFICATION_CONTRACT,
): CertificationFingerprint {
  const localModel = runtime.models.find((candidate) => candidate.id === model);
  const runtimeIdHash = hash([runtime.id]);
  const endpointHash = hash([runtime.endpoint.baseUrl.replace(/\/+$/, "")]);
  const chatBaseHash = hash([runtime.chatBaseUrl.replace(/\/+$/, "")]);
  const modelHash = hash([model]);
  const versionHash = identity.runtimeVersion === null ? "unknown" : hash([identity.runtimeVersion]);
  const digestHash = identity.modelDigest === null ? "unknown" : hash([identity.modelDigest]);
  const contractHash = certificationContractFingerprint(contract);
  const kindHash = hash([runtime.kind]);
  const contextHash = hash([String(localModel?.contextWindow ?? "unknown")]);
  const toolsHash = hash([String(localModel?.tools ?? "unknown")]);
  return {
    hash: hash([
      runtimeIdHash,
      endpointHash,
      chatBaseHash,
      modelHash,
      versionHash,
      digestHash,
      contractHash,
      kindHash,
      contextHash,
      toolsHash,
    ]),
    reusable: identity.runtimeVersion !== null && identity.modelDigest !== null,
  };
}

