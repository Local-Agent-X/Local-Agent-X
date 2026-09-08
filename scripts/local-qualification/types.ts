export const QUALIFICATION_STAGES = [
  "isolated_boot",
  "passive_pre_certification",
  "operator_certification",
  "status_reads",
  "chat_sse",
  "workspace_read",
  "file_navigation",
  "compaction",
  "restart_restore",
  "continuity",
] as const;

export type QualificationStageName = (typeof QUALIFICATION_STAGES)[number];

export type QualificationFailure = "failed" | "timeout" | "aborted";

/**
 * Per-scenario evidence carried on a stage. `actions` is the tool-call count
 * of the turn and `failedActions` the subset whose tool_end was not ok, so a
 * scenario that still passes can show a navigation regression numerically.
 */
export interface QualificationScenarioEvidence {
  id: string;
  ok: boolean;
  actions: number;
  failedActions: number;
  durationMs: number;
  failure?: QualificationFailure;
}

export interface QualificationStage {
  name: QualificationStageName;
  ok: boolean;
  durationMs: number;
  failure?: QualificationFailure;
  scenarios?: QualificationScenarioEvidence[];
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

export type FileNavigationScenarioId = "find_app_by_fuzzy_name" | "read_file_section" | "grep_for_symbol";

export interface FileNavigationResult {
  done: boolean;
  errorEvents: number;
  /** Concatenated assistant stream text — scored by run.ts, never placed on the scorecard. */
  finalText: string;
  actions: number;
  failedActions: number;
  /** True when the driver cut the turn off at the action cap. */
  capped: boolean;
}

export interface QualificationDriver {
  readonly model: string;
  forbiddenRequests(): number;
  start(signal: AbortSignal): Promise<void>;
  status(signal: AbortSignal): Promise<RuntimeStatus>;
  certify(runtimeId: string, signal: AbortSignal): Promise<CertificationResult>;
  chat(kind: "baseline" | "workspace-read" | "history" | "continuity", signal: AbortSignal): Promise<ChatResult>;
  /**
   * Runs one file_navigation scenario in a fresh session against the fixture
   * the driver created at start. `onProgress` fires after every tool
   * lifecycle event so the stage keeps the action count when the scenario
   * times out before the driver returns.
   */
  navigate(
    scenario: FileNavigationScenarioId,
    signal: AbortSignal,
    onProgress?: (progress: { actions: number; failedActions: number }) => void,
  ): Promise<FileNavigationResult>;
  compact(signal: AbortSignal): Promise<CompactionResult>;
  persistedSummary(signal: AbortSignal): Promise<{ persisted: boolean; containsMarker: boolean }>;
  restart(signal: AbortSignal): Promise<void>;
  cleanup(signal: AbortSignal): Promise<void>;
}

export {
  QUALIFICATION_RESULT_SCHEMA,
  QUALIFICATION_RESULT_VERSION,
  QUALIFICATION_SCORECARD_SCHEMA,
  QUALIFICATION_SCORECARD_VERSION,
  aggregateQualificationResults,
  parseQualificationResult,
  parseQualificationScorecard,
  sealQualificationResult,
} from "./result-schema.js";
export type {
  QualificationEvidenceReference,
  QualificationFailureKind,
  QualificationPackContract,
  QualificationResult,
  QualificationScorecard as AggregateQualificationScorecard,
  QualificationStatus,
} from "./result-schema.js";
