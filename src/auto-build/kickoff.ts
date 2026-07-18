import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ToolResult } from "../types.js";
import { defaultJudgmentHook } from "./chunk-review/judgment-hook.js";
import { checkSystemic, readBuildState } from "./failure-recovery.js";
import { startOrchestration } from "./orchestrator/manager.js";
import type {
  StartOrchestrationOptions,
  StartOrchestrationResult,
} from "./orchestrator/manager.js";
import { parsePlanFile } from "./plan-parser.js";
import { resolveProjectDir } from "./project-paths.js";

export const FEATURE_FLAG_ENV = "LAX_AUTO_BUILD_ENABLED";
const LEGACY_FEATURE_FLAG_ENV = "PRIMAL_AUTO_BUILD_ENABLED";

export function isFeatureEnabled(): boolean {
  const raw = process.env[FEATURE_FLAG_ENV] ?? process.env[LEGACY_FEATURE_FLAG_ENV] ?? "";
  const value = String(raw).trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(value);
}

export interface BuildPlanKickoffInput {
  projectDir: unknown;
  planPath?: unknown;
  startingChunk?: unknown;
  maxChunks?: unknown;
  sessionId?: unknown;
}

export type BuildPlanKickoff = (input: BuildPlanKickoffInput) => Promise<ToolResult>;

interface BuildPlanKickoffDeps {
  start: (opts: StartOrchestrationOptions) => StartOrchestrationResult;
  diagnoseSystemic: (
    projectDir: string,
    gate: string,
    recentHalts: ReturnType<typeof readBuildState>["haltHistory"],
  ) => Promise<string>;
}

async function diagnoseSystemic(
  projectDir: string,
  gate: string,
  recentHalts: ReturnType<typeof readBuildState>["haltHistory"],
): Promise<string> {
  try {
    const { consultAdvisor } = await import("./advisor/index.js");
    const advice = await consultAdvisor({
      kind: "systemic-halt-pattern",
      gate,
      recentHalts,
      projectDir,
    });
    return advice?.haltReason ? `\n\nAdvisor diagnostic:\n${advice.haltReason}` : "";
  } catch {
    return "";
  }
}

export function createBuildPlanKickoff(
  overrides: Partial<BuildPlanKickoffDeps> = {},
): BuildPlanKickoff {
  const deps: BuildPlanKickoffDeps = {
    start: overrides.start ?? startOrchestration,
    diagnoseSystemic: overrides.diagnoseSystemic ?? diagnoseSystemic,
  };

  return async input => {
    if (!isFeatureEnabled()) {
      return {
        content:
          `BLOCKED — run_build_plan was explicitly disabled via ${FEATURE_FLAG_ENV} ` +
          `(set to 0/false/no/off). The tool is opt-out and runs by default; unset the flag ` +
          `or set it to any other value, then restart to re-enable.`,
        isError: true,
        status: "blocked",
        metadata: {
          recovery: `unset ${FEATURE_FLAG_ENV} (or set to a non-disabling value) in the LAX server environment and restart`,
        },
      };
    }

    const projectDir = resolveProjectDir(input.projectDir);
    if (!projectDir) {
      return {
        content: "run_build_plan requires 'project_dir' (bare project name like 'petbook', or an absolute path).",
        isError: true,
      };
    }
    if (!existsSync(projectDir)) {
      return { content: `project_dir does not exist: ${projectDir}`, isError: true };
    }

    const planPathRaw = String(input.planPath || "").trim();
    const planPath = planPathRaw
      ? (isAbsolute(planPathRaw) ? planPathRaw : resolve(projectDir, planPathRaw))
      : resolve(projectDir, "spec", "plan.md");
    if (!existsSync(planPath)) {
      return {
        content: `plan not found at ${planPath}. Run /app-build first to produce spec/plan.md, or pass plan_path explicitly.`,
        isError: true,
      };
    }

    let plan;
    try {
      plan = parsePlanFile(planPath);
    } catch (error) {
      return { content: `plan parse failed: ${(error as Error).message}`, isError: true };
    }

    const buildState = readBuildState(projectDir);
    const systemic = checkSystemic(buildState);
    if (systemic.systemic) {
      const diagnostic = await deps.diagnoseSystemic(
        projectDir,
        systemic.gate || "",
        buildState.haltHistory.slice(-3),
      );
      return {
        content:
          `BLOCKED — ${systemic.advice}${diagnostic}\n\n` +
          `To override: delete .lax-build-history.json in the project dir, or amend the spec / fix the gate cause first.`,
        isError: true,
        status: "blocked",
        metadata: {
          systemic_gate: systemic.gate,
          systemic_count: systemic.count,
          advisor_diagnosed: diagnostic.length > 0,
        },
      };
    }

    const startingChunkArg = Number(input.startingChunk);
    const maxChunksArg = Number(input.maxChunks);
    const startingChunk = Number.isFinite(startingChunkArg) && startingChunkArg > 0
      ? Math.floor(startingChunkArg)
      : plan.chunks[0].number;
    const maxChunks = Number.isFinite(maxChunksArg) && maxChunksArg > 0
      ? Math.floor(maxChunksArg)
      : undefined;
    const sessionId = typeof input.sessionId === "string" && input.sessionId.trim()
      ? input.sessionId.trim()
      : `orchestrator-${Date.now().toString(36)}`;

    let kick: StartOrchestrationResult;
    try {
      kick = deps.start({
        sessionId,
        projectDir,
        planPath,
        plan,
        startingChunk,
        maxChunks,
        judgmentHook: defaultJudgmentHook,
      });
    } catch (error) {
      const message = (error as Error).message;
      const duplicate = message.includes("already running");
      return {
        content: `Build plan kickoff ${duplicate ? "blocked" : "failed"}: ${message}`,
        isError: true,
        status: duplicate ? "blocked" : "error",
        metadata: duplicate
          ? { recovery: "Use build_plan_status for the running Product Build instead of starting another." }
          : undefined,
      };
    }

    return {
      content: kick.initialMessage,
      status: "running",
      session_id: kick.opId,
      metadata: {
        op_id: kick.opId,
        project_dir: projectDir,
        plan_chunks: plan.chunks.length,
        starting_chunk: startingChunk,
        max_chunks: maxChunks,
      },
    };
  };
}

export const kickoffBuildPlan = createBuildPlanKickoff();
