/**
 * primal_run_build_plan — run an /app-build plan to code-completion.
 *
 * Reads spec/plan.md from a target project, spawns a fresh Claude Code
 * subprocess per chunk with the right skill, runs a /chunk-review gate
 * after each, halts at phase-gates and launch-readiness blockers.
 *
 * Design: ~/.claude/projects/c--Users-manri-local-agent-x/memory/project_primal_auto_build_tool_design.md
 *
 * Gated behind the PRIMAL_AUTO_BUILD_ENABLED env flag — default off.
 * Until graduation criteria met, the tool refuses to run unless explicitly
 * enabled. Graduation criteria live in the design doc.
 *
 * Chunk 1 scope: tool registration + single-chunk subprocess spawn.
 * No plan parser yet — caller passes the chunk prompt directly.
 * No review pass, no loop, no commit logic. Each subsequent chunk
 * (parser, classifier, review, loop, gates, recovery) layers in over
 * the same primitive.
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ToolDefinition, ToolResult } from "../types.js";
import { parsePlanFile } from "./plan-parser.js";
import { readBuildState, checkSystemic } from "./failure-recovery.js";
import { defaultJudgmentHook } from "./chunk-review/judgment-hook.js";
import { startOrchestration } from "./orchestrator/manager.js";
import { resolveProjectDir } from "./project-paths.js";

export const FEATURE_FLAG_ENV = "PRIMAL_AUTO_BUILD_ENABLED";

export function isFeatureEnabled(): boolean {
  const v = String(process.env[FEATURE_FLAG_ENV] || "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "no" || v === "off");
}

export const primalRunBuildPlanTool: ToolDefinition = {
  name: "primal_run_build_plan",
  description:
    "Run an /app-build plan to code-completion. **Returns immediately with an opId**; the actual " +
    "build runs in the background and progresses live in the AGENTS sidebar. State persists " +
    "across LAX restarts; use `primal_build_resume` to pick up where a halted build left off.\n\n" +
    "Loop: spawns a fresh Claude Code (or Codex) subprocess per chunk with the right skill " +
    "(/senior-engineer for trunk, /vibe-code for leaf), runs the /chunk-review gates (done-when + " +
    "additive spec-diff + phase-gate + launch-readiness + test-failure), halts at phase-gates and " +
    "launch-readiness blockers. Each gate halt persists to disk so a restart can resume.\n\n" +
    "Companion to /app-build: where that produces the spec, this consumes it.\n\n" +
    "Opt-out via PRIMAL_AUTO_BUILD_ENABLED env flag — default ON. Set the flag to " +
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
        description: "1-indexed chunk to start at. Default: first chunk in the plan. " +
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
    if (!isFeatureEnabled()) {
      return {
        content:
          `BLOCKED — primal_run_build_plan was explicitly disabled via ${FEATURE_FLAG_ENV} ` +
          `(set to 0/false/no/off). The tool is opt-out and runs by default; unset the flag ` +
          `or set it to any other value, then restart to re-enable.`,
        isError: true,
        status: "blocked",
        metadata: { recovery: `unset ${FEATURE_FLAG_ENV} (or set to a non-disabling value) in the LAX server environment and restart` },
      };
    }

    const projectDir = resolveProjectDir(args.project_dir);
    if (!projectDir) {
      return { content: "primal_run_build_plan requires 'project_dir' (bare project name like 'mygroomtime', or an absolute path).", isError: true };
    }
    if (!existsSync(projectDir)) {
      return { content: `project_dir does not exist: ${projectDir}`, isError: true };
    }

    const planPathRaw = String(args.plan_path || "").trim();
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
    } catch (e) {
      return { content: `plan parse failed: ${(e as Error).message}`, isError: true };
    }

    // Systemic-issue pre-flight check. If the last 3 halts all fired on
    // the same gate, refuse to start and ask the user to investigate
    // root cause rather than blindly retrying. When the advisor is
    // available, also ask it for a focused diagnostic the user can act
    // on — turning a dead-end into a directed investigation.
    const buildState = readBuildState(projectDir);
    const systemic = checkSystemic(buildState);
    if (systemic.systemic) {
      let diagnostic = "";
      try {
        const { consultAdvisor } = await import("./advisor/index.js");
        const advice = await consultAdvisor({
          kind: "systemic-halt-pattern",
          gate: systemic.gate || "",
          recentHalts: buildState.haltHistory.slice(-3),
          projectDir,
        });
        if (advice?.haltReason) diagnostic = `\n\nAdvisor diagnostic:\n${advice.haltReason}`;
      } catch { /* fail open — advisor is augmentation, not gating */ }

      return {
        content:
          `BLOCKED — ${systemic.advice}${diagnostic}\n\n` +
          `To override: delete .primal-build-state.json in the project dir, or amend the spec / fix the gate cause first.`,
        isError: true,
        status: "blocked",
        metadata: { systemic_gate: systemic.gate, systemic_count: systemic.count, advisor_diagnosed: diagnostic.length > 0 },
      };
    }

    const startingChunkArg = Number(args.starting_chunk);
    const maxChunksArg = Number(args.max_chunks);
    const startingChunk = Number.isFinite(startingChunkArg) && startingChunkArg > 0
      ? Math.floor(startingChunkArg)
      : plan.chunks[0].number;
    const maxChunks = Number.isFinite(maxChunksArg) && maxChunksArg > 0 ? Math.floor(maxChunksArg) : undefined;

    const sessionId = typeof args._sessionId === "string" ? args._sessionId : "";
    if (!sessionId) {
      return {
        content: "primal_run_build_plan needs a chat session context to surface live progress in the sidebar. Internal: _sessionId was not injected.",
        isError: true,
      };
    }

    // Async kick-off: register the orchestrator op, return immediately.
    // Loop runs in background; bg_op_progress / bg_op_completed events
    // populate the AGENTS sidebar and route a completion message back to
    // the chat session. State persists across LAX restarts via
    // .primal-orchestrator-state.json — primal_build_resume picks it up.
    const kick = startOrchestration({
      sessionId,
      projectDir,
      planPath,
      plan,
      startingChunk,
      maxChunks,
      judgmentHook: defaultJudgmentHook,
    });

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
  },
};
