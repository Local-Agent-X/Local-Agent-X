import { createHash } from "node:crypto";
import type { CertificationFingerprint, CertificationIdentity } from "./certification-types.js";
import type { LocalRuntimeInfo } from "./types.js";

function hash(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function certificationFingerprint(
  runtime: LocalRuntimeInfo,
  model: string,
  identity: CertificationIdentity,
): CertificationFingerprint {
  const endpointHash = hash([runtime.endpoint.baseUrl.replace(/\/+$/, "")]);
  const modelHash = hash([model]);
  const versionHash = identity.runtimeVersion === null ? "unknown" : hash([identity.runtimeVersion]);
  const digestHash = identity.modelDigest === null ? "unknown" : hash([identity.modelDigest]);
  return {
    hash: hash([endpointHash, modelHash, versionHash, digestHash]),
    reusable: identity.runtimeVersion !== null && identity.modelDigest !== null,
  };
}

