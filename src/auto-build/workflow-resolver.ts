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
}

const defaultSources: AppBuildContinuationSources = {
  readWorkflow: readAppBuildWorkflow,
  listWorkflows: () => queryAppBuildWorkflows(),
  listRegistered: listRegisteredOrchestrators,
  listActive,
  readProjectState,
};

interface ProjectEvidence {
  projectDir: string;
  workflows: AppBuildWorkflow[];
  registered: RegistryEntry[];
  active: ActiveOrchestrationSummary[];
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

  const projectState = sources.readProjectState(evidence.projectDir);
  if (projectState) {
    const { state, planExists } = projectState;
    if (state.phase === "starting" || state.phase === "running") {
      return {
        action: "build_plan_status",
        phase: state.phase,
        projectDir: state.projectDir,
        opId: state.opId,
        sessionIds: unique([...sessionIds, state.sessionId]),
        resumable: false,
        adoptable: true,
        reason: `Persisted orchestration state is ${state.phase}.`,
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
    return {
      action: "run_build_plan",
      phase: "finalized",
      projectDir: evidence.projectDir,
      opId: workflow.opId,
      sessionIds,
      resumable: false,
      adoptable: true,
      reason: "The Product Build is finalized and has no orchestration state yet.",
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

/**
 * Resolve durable Product Build state only. Message intent remains owned by
 * request preparation; callers use this result before generic app routing.
 */
export function resolveAppBuildContinuation(
  sessionId: string,
  sources: AppBuildContinuationSources = defaultSources,
): AppBuildContinuationResolution {
  const workflow = sources.readWorkflow(sessionId);
  const workflows = sources.listWorkflows();
  const registered = sources.listRegistered();
  const active = sources.listActive();

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
