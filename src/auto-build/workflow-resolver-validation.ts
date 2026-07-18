import type { OrchestratorState } from "./orchestrator/state.js";
import type { RegistryEntry } from "./orchestrator/registry.js";
import type { AppBuildWorkflow } from "./workflow-state.js";

export interface ActiveOrchestrationSummary {
  opId: string;
  projectDir: string;
  sessionId: string;
  startedAt: number;
}

export interface ProjectStateSummary {
  state: OrchestratorState;
  planExists: boolean;
}

const WORKFLOW_PHASES = new Set<AppBuildWorkflow["phase"]>([
  "planning", "finalized", "running", "halted", "complete",
]);
const ORCHESTRATOR_PHASES = new Set<OrchestratorState["phase"]>([
  "starting", "running", "halted", "complete", "abandoned",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

export function sanitizeWorkflow(value: unknown): AppBuildWorkflow | null {
  if (!isRecord(value)
    || value.kind !== "app-build"
    || !isNonEmptyString(value.sessionId)
    || !WORKFLOW_PHASES.has(value.phase as AppBuildWorkflow["phase"])
    || !isTimestamp(value.createdAt)
    || !isTimestamp(value.updatedAt)
    || (value.projectDir !== undefined && !isNonEmptyString(value.projectDir))
    || (value.opId !== undefined && !isNonEmptyString(value.opId))) return null;
  return value as unknown as AppBuildWorkflow;
}

export function sanitizeRegistryEntry(value: unknown): RegistryEntry | null {
  if (!isRecord(value)
    || !isNonEmptyString(value.projectDir)
    || !isNonEmptyString(value.opId)
    || !isNonEmptyString(value.sessionId)
    || !isTimestamp(value.registeredAt)) return null;
  return value as unknown as RegistryEntry;
}

export function sanitizeActive(value: unknown): ActiveOrchestrationSummary | null {
  if (!isRecord(value)
    || !isNonEmptyString(value.projectDir)
    || !isNonEmptyString(value.opId)
    || !isNonEmptyString(value.sessionId)
    || typeof value.startedAt !== "number"
    || !Number.isFinite(value.startedAt)) return null;
  return value as unknown as ActiveOrchestrationSummary;
}

export function sanitizeProjectState(value: unknown): ProjectStateSummary | null {
  if (!isRecord(value)
    || typeof value.planExists !== "boolean"
    || !isRecord(value.state)
    || !isNonEmptyString(value.state.projectDir)
    || !isNonEmptyString(value.state.opId)
    || !isNonEmptyString(value.state.sessionId)
    || !ORCHESTRATOR_PHASES.has(value.state.phase as OrchestratorState["phase"])) return null;
  return value as unknown as ProjectStateSummary;
}

export function readSafely<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

export function sanitizeList<T>(values: unknown, sanitize: (value: unknown) => T | null): T[] {
  if (!Array.isArray(values)) return [];
  return values.map(sanitize).filter((value): value is T => value !== null);
}
