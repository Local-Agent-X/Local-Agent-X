import type { LearnedActivationCause, LearnedActivationKind, LearnedProtocolRecord } from "./learned-lifecycle.js";

const MAX_ACTIVATION_HISTORY = 100;
const ACTIVATION_KINDS = new Set<LearnedActivationKind>(["activate", "restore", "rollback", "archive"]);
const ACTIVATION_CAUSES = new Set<LearnedActivationCause>(["safety"]);
const ENTRY_KEYS = "kind,previousVersionId,reason,timestamp,versionId";
const ENTRY_KEYS_WITH_CAUSE = "cause,kind,previousVersionId,reason,timestamp,versionId";

export function validateActivationHistory(record: LearnedProtocolRecord, slug: string): void {
  const value = record.activationHistory;
  if (!Array.isArray(value) || value.length > MAX_ACTIVATION_HISTORY) {
    throw new Error(`Invalid learned protocol activation history: ${slug}`);
  }
  const versionIds = new Set(record.versions.map((version) => version.id));
  let priorTimestamp = 0;
  let trackedVersion: string | null | undefined;
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Invalid learned protocol activation history: ${slug}`);
    const item = entry as unknown as Record<string, unknown>;
    const keys = Object.keys(item).sort().join(",");
    if (
      (keys !== ENTRY_KEYS && keys !== ENTRY_KEYS_WITH_CAUSE)
      || !ACTIVATION_KINDS.has(item.kind as LearnedActivationKind)
      || (item.cause !== undefined && !ACTIVATION_CAUSES.has(item.cause as LearnedActivationCause))
      || typeof item.versionId !== "string"
      || !versionIds.has(item.versionId)
      || (item.previousVersionId !== null && (typeof item.previousVersionId !== "string" || !versionIds.has(item.previousVersionId)))
      || typeof item.timestamp !== "number"
      || !Number.isFinite(item.timestamp)
      || item.timestamp <= 0
      || typeof item.reason !== "string"
      || item.reason.trim().length === 0
      || item.reason.length > 200
      || (item.kind === "archive" && item.previousVersionId !== item.versionId)
      || (trackedVersion !== undefined && item.previousVersionId !== trackedVersion)
      || (item.timestamp as number) < priorTimestamp
    ) throw new Error(`Invalid learned protocol activation history: ${slug}`);
    trackedVersion = item.versionId as string;
    priorTimestamp = item.timestamp as number;
  }
  if (value.length > 0 && trackedVersion !== record.activeVersionId) {
    throw new Error(`Invalid learned protocol activation history: ${slug}`);
  }
}

export function recordActivation(
  record: LearnedProtocolRecord, kind: LearnedActivationKind, versionId: string,
  previousVersionId: string | null, reason: string | undefined, timestamp: number | undefined,
  cause?: LearnedActivationCause,
): void {
  const at = timestamp ?? Date.now();
  const why = reason?.trim() || `${kind[0].toUpperCase()}${kind.slice(1)} learned protocol`;
  if (!Number.isFinite(at) || at <= 0 || why.length > 200) throw new Error("Invalid learned protocol activation history entry");
  record.activationHistory = [
    ...(record.activationHistory ?? []),
    { kind, versionId, previousVersionId, timestamp: at, reason: why, ...(cause ? { cause } : {}) },
  ].slice(-MAX_ACTIVATION_HISTORY);
}
