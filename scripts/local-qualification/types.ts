export const QUALIFICATION_STAGES = [
  "isolated_boot",
  "passive_pre_certification",
  "operator_certification",
  "status_reads",
  "chat_sse",
  "workspace_read",
  "compaction",
  "restart_restore",
  "continuity",
] as const;

export type QualificationStageName = (typeof QUALIFICATION_STAGES)[number];

export interface QualificationStage {
  name: QualificationStageName;
  ok: boolean;
  durationMs: number;
  failure?: "failed" | "timeout" | "aborted";
}

export interface QualificationScorecard {
  version: 1;
  ok: boolean;
  runtime: "ollama";
  model: { tag: string; digest: string | null };
  stages: QualificationStage[];
  cleanup: { ok: boolean };
}

export interface RuntimeStatus {
  found: boolean;
  verified: boolean;
  runtimeId: string;
  digest: string | null;
  certificationCalls: number;
}

export interface CertificationResult {
  ok: boolean;
  operatorGuarded: boolean;
  passedCount: number;
  scenarioCount: number;
  callCount: number;
  scenarioIds: string[];
}

export interface ChatResult {
  done: boolean;
  hasText: boolean;
  errorEvents: number;
  safeReadLifecycle: boolean;
  forbiddenControlEvents: number;
  readNonceSeen: boolean;
  continuityMarkerSeen: boolean;
}

export interface CompactionResult {
  ok: boolean;
  backgroundRequests: number;
  persistedMessageCount: number;
  persistedSummary: boolean;
  summaryIsLeading: boolean;
  summaryContainsMarker: boolean;
}

export interface QualificationDriver {
  readonly model: string;
  forbiddenRequests(): number;
  start(signal: AbortSignal): Promise<void>;
  status(signal: AbortSignal): Promise<RuntimeStatus>;
  certify(runtimeId: string, signal: AbortSignal): Promise<CertificationResult>;
  chat(kind: "baseline" | "workspace-read" | "history" | "continuity", signal: AbortSignal): Promise<ChatResult>;
  compact(signal: AbortSignal): Promise<CompactionResult>;
  persistedSummary(signal: AbortSignal): Promise<{ persisted: boolean; containsMarker: boolean }>;
  restart(signal: AbortSignal): Promise<void>;
  cleanup(signal: AbortSignal): Promise<void>;
}
