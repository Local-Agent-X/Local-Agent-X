import type { LocalRuntimeEndpoint, LocalRuntimeKind } from "./types.js";

export const CERTIFICATION_SCENARIOS = [
  "baseline_marker",
  "strict_json_schema",
  "required_tool_call",
  "tool_result_continuation",
  "context_degradation",
] as const;

export type CertificationScenarioId = (typeof CERTIFICATION_SCENARIOS)[number];

export type CertificationFailure =
  | "aborted"
  | "auth_rejected"
  | "bad_response"
  | "context_rejected"
  | "invalid_json"
  | "missing_marker"
  | "missing_tool_call"
  | "runtime_unavailable"
  | "server_error"
  | "timeout"
  | "transport_error";

export interface CertificationIdentity {
  runtimeVersion: string | null;
  modelDigest: string | null;
}

export interface CertificationFingerprint {
  hash: string;
  reusable: boolean;
}

export interface CertificationScenarioResult {
  passed: boolean;
  calls: number;
  latencyMs: number;
  failure: CertificationFailure | null;
}

export interface LocalModelCertification {
  version: 1;
  fingerprint: CertificationFingerprint;
  scenarios: Record<CertificationScenarioId, CertificationScenarioResult>;
  passedCount: number;
  callCount: number;
  totalLatencyMs: number;
}

export interface CertificationRequest {
  endpoint: LocalRuntimeEndpoint;
  kind: LocalRuntimeKind;
  model: string;
  body: Record<string, unknown>;
  signal: AbortSignal;
}

export interface CertificationResponse {
  status: number;
  body: unknown;
}

export type CertificationTransport = (
  request: CertificationRequest,
) => Promise<CertificationResponse>;
