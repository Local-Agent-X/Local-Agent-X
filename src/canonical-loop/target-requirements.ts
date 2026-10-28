/**
 * Does a runtime target meet an op's requirements? The one predicate failover
 * (runtime-failover.ts) applies both to a fresh candidate and to a persisted
 * failover target before resuming on it. The requirements are persisted facts
 * (ops/operation-requirements.ts); the capability snapshot is the target's.
 */
import { requestBudgetTokens } from "../context-manager/output-reserve.js";
import type { TargetCapabilitySnapshot } from "../ops/operation-requirements.js";
import type { ProviderCapabilityRequirement } from "../ops/types.js";

export function targetMeetsRequirements(
  requirements: ProviderCapabilityRequirement,
  capabilities: TargetCapabilitySnapshot,
  certified: boolean,
  model: string,
): boolean {
  if (capabilities.locality === "local" && !certified) return false;
  if (requirements.locality === "local-only" && capabilities.locality !== "local") return false;
  if (requirements.needsTools && capabilities.tools !== "supported") return false;
  if (requirements.needsVision && capabilities.vision !== "supported") return false;
  if (requirements.needsStreaming && capabilities.streaming !== "supported") return false;
  if (requirements.needsJsonMode && capabilities.jsonMode !== "supported") return false;
  if (requirements.needsLocalFiles && capabilities.localFiles !== "supported") return false;
  const window = capabilities.contextWindowTokens;
  if (requirements.minimumContextTokens && (window === null || window < requirements.minimumContextTokens)) return false;
  // The candidate's own reply reserve, as its preflight applies it: a local
  // thinking model keeps 4k..8k, so a request that fits under the flat 1,024
  // would be picked here and then refused there.
  if (requirements.requestTokens && (window === null || requestBudgetTokens(model, window) < requirements.requestTokens)) {
    return false;
  }
  return true;
}
