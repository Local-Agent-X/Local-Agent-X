import { describe, expect, it } from "vitest";
import type { OrchestratorState } from "./orchestrator/state.js";
import type { RegistryEntry } from "./orchestrator/registry.js";
import type { AppBuildWorkflow } from "./workflow-state.js";
import {
  resolveAppBuildContinuation,
  type AppBuildContinuationSources,
} from "./workflow-resolver.js";

function workflow(
  sessionId: string,
  phase: AppBuildWorkflow["phase"],
  projectDir?: string,
): AppBuildWorkflow {
  return {
    kind: "app-build",
    sessionId,
    phase,
    ...(projectDir ? { projectDir } : {}),
    createdAt: "2026-07-17T12:00:00.000Z",
    updatedAt: "2026-07-17T12:00:00.000Z",
  };
}

function state(
  projectDir: string,
  phase: OrchestratorState["phase"],
  sessionId = "owner",
): OrchestratorState {
  return {
    version: 1,
    opId: `op-${phase}`,
    sessionId,
    projectDir,
    planPath: `${projectDir}\\spec\\plan.md`,
    totalChunks: 6,
    currentChunk: 2,
    resumeAtChunk: 3,
    chunksCommitted: 2,
    phase,
    haltReason: phase === "halted" ? "gate failed" : "",
    haltGate: phase === "halted" ? "test" : null,
    startedAt: "2026-07-17T12:00:00.000Z",
    updatedAt: "2026-07-17T12:30:00.000Z",
    completedAt: phase === "complete" ? "2026-07-17T12:30:00.000Z" : null,
    startingChunkOverride: 1,
    maxChunks: null,
  };
}

function sources(input: {
  workflows?: AppBuildWorkflow[];
  registered?: RegistryEntry[];
  active?: Array<{ opId: string; projectDir: string; sessionId: string; startedAt: number }>;
  states?: Array<{ state: OrchestratorState; planExists: boolean }>;
} = {}): AppBuildContinuationSources {
  const workflows = input.workflows ?? [];
  const states = input.states ?? [];
  const normalize = (value: string): string => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return {
    readWorkflow: sessionId => workflows.find(item => item.sessionId === sessionId) ?? null,
    listWorkflows: () => workflows,
    listRegistered: () => input.registered ?? [],
    listActive: () => input.active ?? [],
    readProjectState: projectDir =>
      states.find(item => normalize(item.state.projectDir) === normalize(projectDir)) ?? null,
  };
}

describe("Product Build continuation resolver", () => {
  it("keeps a compacted planning session in Product Build conversation", () => {
    const result = resolveAppBuildContinuation("planning-session", sources({
      workflows: [workflow("planning-session", "planning")],
    }));

    expect(result).toMatchObject({
      kind: "resolved",
      action: "conversation",
      adopted: false,
      candidate: { phase: "planning" },
    });
  });

  it("uses restarted running state instead of a stale bridge phase", () => {
    const projectDir = "C:\\Apps\\Calendar";
    const result = resolveAppBuildContinuation("owner", sources({
      workflows: [workflow("owner", "finalized", "c:/apps/calendar/")],
      registered: [{
        projectDir,
        opId: "op-running",
        sessionId: "owner",
        registeredAt: "2026-07-17T12:00:00.000Z",
      }],
      states: [{ state: state(projectDir, "running"), planExists: true }],
    }));

    expect(result).toMatchObject({
      kind: "resolved",
      action: "build_plan_status",
      adopted: false,
      candidate: { phase: "running", projectDir, opId: "op-running" },
    });
  });

  it("routes valid halted and abandoned states to resume", () => {
    for (const phase of ["halted", "abandoned"] as const) {
      const projectDir = `C:\\Apps\\${phase}`;
      const result = resolveAppBuildContinuation("owner", sources({
        workflows: [workflow("owner", "running", projectDir)],
        states: [{ state: state(projectDir, phase), planExists: true }],
      }));

      expect(result).toMatchObject({
        kind: "resolved",
        action: "build_plan_resume",
        candidate: { phase, resumable: true },
      });
    }
  });

  it("does not offer resume when a halted build has lost its plan", () => {
    const projectDir = "C:\\Apps\\NoPlan";
    const result = resolveAppBuildContinuation("owner", sources({
      workflows: [workflow("owner", "halted", projectDir)],
      states: [{ state: state(projectDir, "halted"), planExists: false }],
    }));

    expect(result).toMatchObject({
      kind: "resolved",
      action: "build_plan_status",
      candidate: { resumable: false, adoptable: false },
    });
  });

  it("routes finalized-but-not-started state to run_build_plan", () => {
    const projectDir = "C:\\Apps\\Finalized";
    const result = resolveAppBuildContinuation("owner", sources({
      workflows: [workflow("owner", "finalized", projectDir)],
    }));

    expect(result).toMatchObject({
      kind: "resolved",
      action: "run_build_plan",
      adopted: false,
      candidate: { phase: "finalized", projectDir },
    });
  });

  it("adopts exactly one actionable candidate into a fresh chat", () => {
    const projectDir = "C:\\Apps\\ResumeMe";
    const result = resolveAppBuildContinuation("fresh-session", sources({
      registered: [{
        projectDir,
        opId: "op-halted",
        sessionId: "old-session",
        registeredAt: "2026-07-17T12:00:00.000Z",
      }],
      states: [{ state: state(projectDir, "halted", "old-session"), planExists: true }],
    }));

    expect(result).toMatchObject({
      kind: "resolved",
      action: "build_plan_resume",
      adopted: true,
      candidate: { projectDir, resumable: true },
    });
  });

  it("returns candidates instead of guessing when a fresh chat sees multiple builds", () => {
    const first = "C:\\Apps\\One";
    const second = "C:\\Apps\\Two";
    const result = resolveAppBuildContinuation("fresh-session", sources({
      workflows: [
        workflow("old-one", "finalized", first),
        workflow("old-two", "finalized", second),
      ],
    }));

    expect(result).toMatchObject({ kind: "ambiguous", action: null });
    if (result.kind !== "ambiguous") throw new Error("expected ambiguous resolution");
    expect(result.candidates.map(item => item.projectDir)).toEqual([first, second]);
    expect(result.candidates.every(item => item.action === "run_build_plan")).toBe(true);
  });

  it("deduplicates Windows path variants across workflow, registry, and live state", () => {
    const result = resolveAppBuildContinuation("fresh-session", sources({
      workflows: [workflow("old-session", "finalized", "C:\\Apps\\Calendar")],
      registered: [{
        projectDir: "c:/apps/calendar/",
        opId: "op-live",
        sessionId: "old-session",
        registeredAt: "2026-07-17T12:00:00.000Z",
      }],
      active: [{
        projectDir: "C:\\APPS\\CALENDAR\\",
        opId: "op-live",
        sessionId: "old-session",
        startedAt: Date.now(),
      }],
    }));

    expect(result).toMatchObject({
      kind: "resolved",
      action: "build_plan_status",
      adopted: true,
      candidate: { opId: "op-live" },
    });
  });

  it("keeps complete workflows out of Quick Build without adopting them into fresh chats", () => {
    const linked = resolveAppBuildContinuation("owner", sources({
      workflows: [workflow("owner", "complete", "C:\\Apps\\Done")],
    }));
    const fresh = resolveAppBuildContinuation("fresh", sources({
      workflows: [workflow("owner", "complete", "C:\\Apps\\Done")],
    }));

    expect(linked).toMatchObject({ kind: "resolved", action: "conversation" });
    expect(fresh).toEqual({ kind: "none", action: null, candidates: [] });
  });

  it("does not adopt an invalid halted candidate into a fresh chat", () => {
    const projectDir = "C:\\Apps\\MissingPlan";
    const result = resolveAppBuildContinuation("fresh", sources({
      registered: [{
        projectDir,
        opId: "op-halted",
        sessionId: "old-session",
        registeredAt: "2026-07-17T12:00:00.000Z",
      }],
      states: [{ state: state(projectDir, "halted", "old-session"), planExists: false }],
    }));

    expect(result).toEqual({ kind: "none", action: null, candidates: [] });
  });
});
