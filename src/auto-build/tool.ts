/**
 * run_build_plan — run a /greenfield plan (spec/plan.md) to code-completion.
 *
 * The canonical validation and orchestration kickoff live in kickoff.ts; a
 * build started from a chat is linked to it here.
 */

import type { ToolDefinition, ToolResult } from "../types.js";
import { sessionIdOf } from "../tool-execution/internal-args.js";
import { upsertAppBuildWorkflow } from "./workflow-state.js";
import {
  kickoffBuildPlan,
  type BuildPlanKickoff,
} from "./kickoff.js";

export { AUTO_BUILD_DISABLED_RECOVERY, FEATURE_FLAG_ENV, isFeatureEnabled } from "./kickoff.js";

export function createRunBuildPlanTool(
  kickoff: BuildPlanKickoff = kickoffBuildPlan,
): ToolDefinition {
  return {
    name: "run_build_plan",
    description:
      "Run a /greenfield plan (`spec/plan.md`) to code-completion. **Returns immediately with an opId**; the actual " +
      "build runs in the background and progresses live in the AGENTS sidebar. State persists " +
      "across LAX restarts; use `build_plan_resume` to pick up where a halted build left off.\n\n" +
      "Loop: spawns a fresh Claude Code (or Codex) subprocess per chunk with the right skill " +
      "(/senior-engineer for trunk, /vibe-code for leaf), runs the /chunk-review gates (done-when + " +
      "additive spec-diff + phase-gate + launch-readiness + test-failure), halts at phase-gates and " +
      "launch-readiness blockers. Each gate halt persists to disk so a restart can resume.\n\n" +
      "Companion to /greenfield: where that produces the spec, this consumes it.\n\n" +
      "Opt-out via LAX_AUTO_BUILD_ENABLED env flag — default ON. Set the flag to " +
      "0/false/no/off to disable for this server.",
    parameters: {
      type: "object",
      properties: {
        project_dir: {
          type: "string",
          description: "Absolute path to the target project directory (must contain spec/plan.md).",
        },
        plan_path: {
          type: "string",
          description: "Optional override for the plan path. Default: '<project_dir>/spec/plan.md'.",
        },
        starting_chunk: {
          type: "number",
          description:
            "1-indexed chunk to start at. Default: first chunk in the plan. " +
            "Use this to resume after a phase-gate halt.",
        },
        max_chunks: {
          type: "number",
          description: "Optional cap on how many chunks to run this invocation. Default: all.",
        },
      },
      required: ["project_dir"],
    },
    async execute(args, signal): Promise<ToolResult> {
      const sessionId = sessionIdOf(args);
      const kick = await kickoff({
        projectDir: args.project_dir,
        planPath: args.plan_path,
        startingChunk: args.starting_chunk,
        maxChunks: args.max_chunks,
        sessionId,
        signal,
      });
      return linkToChat(kick, sessionId);
    },
  };
}

export const runBuildPlanTool = createRunBuildPlanTool();

/** A build started from a chat belongs to that chat: its "continue the build"
 *  and "how is it going" turns find it (workflow-resolver.ts). */
function linkToChat(kick: ToolResult, sessionId: string | undefined): ToolResult {
  const projectDir = typeof kick.metadata?.project_dir === "string" ? kick.metadata.project_dir : undefined;
  if (!sessionId || kick.isError || kick.status !== "running" || !projectDir) return kick;
  const opId = String(kick.metadata?.op_id || kick.session_id || "").trim();
  try {
    upsertAppBuildWorkflow({ sessionId, phase: "running", projectDir, ...(opId ? { opId } : {}) });
    return kick;
  } catch (e) {
    return { ...kick, metadata: { ...kick.metadata, workflow_link_error: (e as Error).message } };
  }
}
