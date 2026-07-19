import {
  computeDurableRecordMac,
  verifyDurableRecordMac,
} from "../app-runtime/audit-signing.js";
import type { ExactDelegatedRuntimeDescriptor, Op } from "../ops/types.js";

const DOMAIN = "canonical-delegated-runtime-v1";

export function sealDelegatedRuntime(opId: string, descriptor: Omit<ExactDelegatedRuntimeDescriptor, "integrity">): ExactDelegatedRuntimeDescriptor {
  const payload = canonicalPayload(opId, descriptor);
  return {
    ...descriptor,
    integrity: { scheme: "hmac-sha256-v1", mac: computeDurableRecordMac(DOMAIN, payload) },
  };
}

export function verifyDelegatedRuntimeIntegrity(op: Op): asserts op is Op & { runtimeDescriptor: ExactDelegatedRuntimeDescriptor } {
  const descriptor = op.runtimeDescriptor as ExactDelegatedRuntimeDescriptor | undefined;
  if (!descriptor || descriptor.integrity?.scheme !== "hmac-sha256-v1") throw new Error("delegated runtime integrity metadata is missing");
  const { integrity, ...unsigned } = descriptor;
  if (!verifyDurableRecordMac(DOMAIN, canonicalPayload(op.id, unsigned), integrity.mac)) {
    throw new Error("delegated runtime integrity check failed");
  }
}

function canonicalPayload(opId: string, descriptor: Omit<ExactDelegatedRuntimeDescriptor, "integrity">): string {
  return stableStringify({ opId, descriptor });
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
