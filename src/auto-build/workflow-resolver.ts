import { existsSync } from "node:fs";
import { join } from "node:path";
import type { OrchestratorState } from "./orchestrator/state.js";
import type { RegistryEntry } from "./orchestrator/registry.js";
import { listAll as listRegisteredOrchestrators } from "./orchestrator/registry.js";
import { listActive } from "./orchestrator/manager.js";
import { readProjectState } from "./orchestrator/resume.js";
import {
  normalizeAppBuildProjectDir,
  queryAppBuildWorkflows,
  readAppBuildWorkflow,
  type AppBuildWorkflow,
} from "./workflow-state.js";

export type AppBuildContinuationAction =
  | "conversation"
  | "run_build_plan"
  | "build_plan_status"
  | "build_plan_resume";

export type AppBuildContinuationPhase = AppBuildWorkflow["phase"] | OrchestratorState["phase"];

export interface AppBuildContinuationCandidate {
  action: AppBuildContinuationAction;
  phase: AppBuildContinuationPhase;
  projectDir?: string;
  opId?: string;
  sessionIds: string[];
  resumable: boolean;
  adoptable: boolean;
  reason: string;
}

export type AppBuildContinuationResolution =
  | {
      kind: "none";
      action: null;
      candidates: [];
    }
  | {
      kind: "resolved";
      action: AppBuildContinuationAction;
      candidate: AppBuildContinuationCandidate;
      adopted: boolean;
    }
  | {
      kind: "ambiguous";
      action: null;
      candidates: AppBuildContinuationCandidate[];
    };

interface ActiveOrchestrationSummary {
  opId: string;
  projectDir: string;
  sessionId: string;
  startedAt: number;
}

interface ProjectStateSummary {
  state: OrchestratorState;
  planExists: boolean;
}

export interface AppBuildContinuationSources {
  readWorkflow(sessionId: string): AppBuildWorkflow | null;
  listWorkflows(): AppBuildWorkflow[];
  listRegistered(): RegistryEntry[];
  listActive(): ActiveOrchestrationSummary[];
  readProjectState(projectDir: string): ProjectStateSummary | null;
  planExists(projectDir: string): boolean;
}

const defaultSources: AppBuildContinuationSources = {
  readWorkflow: readAppBuildWorkflow,
  listWorkflows: () => queryAppBuildWorkflows(),
  listRegistered: listRegisteredOrchestrators,
  listActive,
  readProjectState,
  planExists: projectDir => existsSync(join(projectDir, "spec", "plan.md")),
};

interface ProjectEvidence {
  projectDir: string;
  workflows: AppBuildWorkflow[];
  registered: RegistryEntry[];
  active: ActiveOrchestrationSummary[];
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

function sanitizeWorkflow(value: unknown): AppBuildWorkflow | null {
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

function sanitizeRegistryEntry(value: unknown): RegistryEntry | null {
  if (!isRecord(value)
    || !isNonEmptyString(value.projectDir)
    || !isNonEmptyString(value.opId)
    || !isNonEmptyString(value.sessionId)
    || !isTimestamp(value.registeredAt)) return null;
  return value as unknown as RegistryEntry;
}

function sanitizeActive(value: unknown): ActiveOrchestrationSummary | null {
  if (!isRecord(value)
    || !isNonEmptyString(value.projectDir)
    || !isNonEmptyString(value.opId)
    || !isNonEmptyString(value.sessionId)
    || typeof value.startedAt !== "number"
    || !Number.isFinite(value.startedAt)) return null;
  return value as unknown as ActiveOrchestrationSummary;
}

function sanitizeProjectState(value: unknown): ProjectStateSummary | null {
  if (!isRecord(value)
    || typeof value.planExists !== "boolean"
    || !isRecord(value.state)
    || !isNonEmptyString(value.state.projectDir)
    || !isNonEmptyString(value.state.opId)
    || !isNonEmptyString(value.state.sessionId)
    || !ORCHESTRATOR_PHASES.has(value.state.phase as OrchestratorState["phase"])) return null;
  return value as unknown as ProjectStateSummary;
}

function readSafely<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function sanitizeList<T>(values: unknown, sanitize: (value: unknown) => T | null): T[] {
  if (!Array.isArray(values)) return [];
  return values.map(sanitize).filter((value): value is T => value !== null);
}

function sameProject(left: string, right: string): boolean {
  return normalizeAppBuildProjectDir(left) === normalizeAppBuildProjectDir(right);
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function evidenceForProject(
  projectDir: string,
  workflows: AppBuildWorkflow[],
  registered: RegistryEntry[],
  active: ActiveOrchestrationSummary[],
): ProjectEvidence {
  const matchingActive = active.filter(item => sameProject(item.projectDir, projectDir));
  const matchingRegistered = registered.filter(item => sameProject(item.projectDir, projectDir));
  const matchingWorkflows = workflows.filter(item =>
    item.projectDir !== undefined && sameProject(item.projectDir, projectDir));
  return {
    projectDir: matchingActive[0]?.projectDir
      ?? matchingRegistered[0]?.projectDir
      ?? matchingWorkflows[0]?.projectDir
      ?? projectDir,
    workflows: matchingWorkflows,
    registered: matchingRegistered,
    active: matchingActive,
  };
}

function candidateFromEvidence(
  evidence: ProjectEvidence,
  sources: AppBuildContinuationSources,
): AppBuildContinuationCandidate | null {
  const sessionIds = unique([
    ...evidence.workflows.map(item => item.sessionId),
    ...evidence.registered.map(item => item.sessionId),
    ...evidence.active.map(item => item.sessionId),
  ]);
  const live = evidence.active[0];
  if (live) {
    return {
      action: "build_plan_status",
      phase: "running",
      projectDir: evidence.projectDir,
      opId: live.opId,
      sessionIds,
      resumable: false,
      adoptable: true,
      reason: "An orchestration for this project is active in the current process.",
    };
  }

  const storedProjectState = sanitizeProjectState(
    readSafely(() => sources.readProjectState(evidence.projectDir), null),
  );
  const projectState = storedProjectState
    && sameProject(storedProjectState.state.projectDir, evidence.projectDir)
    ? storedProjectState
    : null;
  if (projectState) {
    const { state, planExists } = projectState;
    if ((state.phase === "starting" || state.phase === "running") && planExists) {
      return {
        action: "build_plan_resume",
        phase: state.phase,
        projectDir: state.projectDir,
        opId: state.opId,
        sessionIds: unique([...sessionIds, state.sessionId]),
        resumable: true,
        adoptable: true,
        reason: `Persisted orchestration state is ${state.phase}, but no live orchestration exists.`,
      };
    }
    if ((state.phase === "halted" || state.phase === "abandoned") && planExists) {
      return {
        action: "build_plan_resume",
        phase: state.phase,
        projectDir: state.projectDir,
        opId: state.opId,
        sessionIds: unique([...sessionIds, state.sessionId]),
        resumable: true,
        adoptable: true,
        reason: `Persisted orchestration state is ${state.phase} and its plan is available.`,
      };
    }
    return {
      action: state.phase === "complete" ? "conversation" : "build_plan_status",
      phase: state.phase,
      projectDir: state.projectDir,
      opId: state.opId,
      sessionIds: unique([...sessionIds, state.sessionId]),
      resumable: false,
      adoptable: false,
      reason: planExists
        ? `Persisted orchestration state is ${state.phase}.`
        : `Persisted orchestration state is ${state.phase}, but its plan is unavailable.`,
    };
  }

  const workflow = [...evidence.workflows]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (!workflow) return null;
  if (workflow.phase === "finalized") {
    const planExists = readSafely(() => sources.planExists(evidence.projectDir), false);
    const launchable = planExists && workflow.opId === undefined;
    return {
      action: launchable ? "run_build_plan" : "conversation",
      phase: "finalized",
      projectDir: evidence.projectDir,
      opId: workflow.opId,
      sessionIds,
      resumable: false,
      adoptable: launchable,
      reason: workflow.opId
        ? "The finalized workflow has a kickoff opId, but no live orchestration state remains."
        : planExists
          ? "The Product Build is finalized and its plan is ready to launch."
          : "The Product Build is finalized, but spec/plan.md is missing.",
    };
  }
  return {
    action: "conversation",
    phase: workflow.phase,
    projectDir: evidence.projectDir,
    opId: workflow.opId,
    sessionIds,
    resumable: false,
    adoptable: false,
    reason: `The workflow bridge says ${workflow.phase}, but no live orchestration state exists.`,
  };
}

function candidateForWorkflow(
  workflow: AppBuildWorkflow,
  sources: AppBuildContinuationSources,
  workflows: AppBuildWorkflow[],
  registered: RegistryEntry[],
  active: ActiveOrchestrationSummary[],
): AppBuildContinuationCandidate {
  if (!workflow.projectDir) {
    return {
      action: "conversation",
      phase: workflow.phase,
      opId: workflow.opId,
      sessionIds: [workflow.sessionId],
      resumable: false,
      adoptable: false,
      reason: "The Product Build is still planning and has no finalized project directory.",
    };
  }
  return candidateFromEvidence(
    evidenceForProject(workflow.projectDir, workflows, registered, active),
    sources,
  ) ?? {
    action: "conversation",
    phase: workflow.phase,
    projectDir: workflow.projectDir,
    opId: workflow.opId,
    sessionIds: [workflow.sessionId],
    resumable: false,
    adoptable: false,
    reason: `The workflow bridge says ${workflow.phase}, but no continuation state is available.`,
  };
}

function collectCandidates(
  sources: AppBuildContinuationSources,
  workflows: AppBuildWorkflow[],
  registered: RegistryEntry[],
  active: ActiveOrchestrationSummary[],
): AppBuildContinuationCandidate[] {
  const groups = new Map<string, ProjectEvidence>();
  const add = (projectDir: string): void => {
    const key = normalizeAppBuildProjectDir(projectDir);
    if (!key || groups.has(key)) return;
    groups.set(key, evidenceForProject(projectDir, workflows, registered, active));
  };
  active.forEach(item => add(item.projectDir));
  registered.forEach(item => add(item.projectDir));
  workflows.forEach(item => {
    if (item.projectDir) add(item.projectDir);
  });

  return [...groups.values()]
    .map(evidence => candidateFromEvidence(evidence, sources))
    .filter((candidate): candidate is AppBuildContinuationCandidate => candidate?.adoptable === true);
}

function collectLiveSessionCandidates(
  sessionId: string,
  sources: AppBuildContinuationSources,
  workflows: AppBuildWorkflow[],
  registered: RegistryEntry[],
  active: ActiveOrchestrationSummary[],
): AppBuildContinuationCandidate[] {
  const projects = new Map<string, string>();
  active.filter(item => item.sessionId === sessionId).forEach(item => {
    projects.set(normalizeAppBuildProjectDir(item.projectDir), item.projectDir);
  });
  return [...projects.values()].map(projectDir =>
    candidateFromEvidence(evidenceForProject(projectDir, workflows, registered, active), sources),
  ).filter((candidate): candidate is AppBuildContinuationCandidate => candidate !== null);
}

/**
 * Resolve durable Product Build state only. Message intent remains owned by
 * request preparation; callers use this result before generic app routing.
 */
export function resolveAppBuildContinuation(
  sessionId: string,
  sources: AppBuildContinuationSources = defaultSources,
): AppBuildContinuationResolution {
  const workflow = sanitizeWorkflow(readSafely(() => sources.readWorkflow(sessionId), null));
  const workflows = sanitizeList(readSafely(() => sources.listWorkflows(), []), sanitizeWorkflow);
  if (workflow && !workflows.some(item => item.sessionId === workflow.sessionId)) {
    workflows.push(workflow);
  }
  const registered = sanitizeList(readSafely(() => sources.listRegistered(), []), sanitizeRegistryEntry);
  const active = sanitizeList(readSafely(() => sources.listActive(), []), sanitizeActive);

  const liveSessionCandidates = collectLiveSessionCandidates(
    sessionId, sources, workflows, registered, active,
  );
  if (liveSessionCandidates.length === 1) {
    const candidate = liveSessionCandidates[0];
    return { kind: "resolved", action: candidate.action, candidate, adopted: false };
  }
  if (liveSessionCandidates.length > 1) {
    return { kind: "ambiguous", action: null, candidates: liveSessionCandidates };
  }

  if (workflow) {
    const candidate = candidateForWorkflow(workflow, sources, workflows, registered, active);
    return { kind: "resolved", action: candidate.action, candidate, adopted: false };
  }

  const candidates = collectCandidates(sources, workflows, registered, active);
  const sessionCandidates = candidates.filter(candidate => candidate.sessionIds.includes(sessionId));
  if (sessionCandidates.length === 1) {
    const candidate = sessionCandidates[0];
    return { kind: "resolved", action: candidate.action, candidate, adopted: false };
  }
  if (sessionCandidates.length > 1) {
    return { kind: "ambiguous", action: null, candidates: sessionCandidates };
  }
  if (candidates.length === 1) {
    const candidate = candidates[0];
    return { kind: "resolved", action: candidate.action, candidate, adopted: true };
  }
  if (candidates.length > 1) {
    return { kind: "ambiguous", action: null, candidates };
  }
  return { kind: "none", action: null, candidates: [] };
}
