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
import { runBuildLoop } from "./loop.js";
import { readBuildState, checkSystemic } from "./failure-recovery.js";
import { defaultJudgmentHook } from "./chunk-review/judgment-hook.js";

export const FEATURE_FLAG_ENV = "PRIMAL_AUTO_BUILD_ENABLED";

export function isFeatureEnabled(): boolean {
  const v = String(process.env[FEATURE_FLAG_ENV] || "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "no" || v === "off");
}

export const primalRunBuildPlanTool: ToolDefinition = {
  name: "primal_run_build_plan",
  description:
    "Run an /app-build plan to code-completion. Reads spec/plan.md from a target project, " +
    "spawns a fresh Claude Code subprocess per chunk with the right skill (/senior-engineer for " +
    "trunk, /vibe-code for leaf), runs a /chunk-review gate after each (done-when + additive " +
    "spec-diff + phase-gate + launch-readiness + test-failure), halts at phase-gates and " +
    "launch-readiness blockers instead of trying to drive scenarios autonomously. " +
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

    const projectDirRaw = String(args.project_dir || "").trim();
    if (!projectDirRaw) {
      return { content: "primal_run_build_plan requires 'project_dir'.", isError: true };
    }
    const projectDir = isAbsolute(projectDirRaw) ? projectDirRaw : resolve(process.cwd(), projectDirRaw);
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
    // root cause rather than blindly retrying.
    const systemic = checkSystemic(readBuildState(projectDir));
    if (systemic.systemic) {
      return {
        content:
          `BLOCKED — ${systemic.advice}\n\n` +
          `To override: delete .primal-build-state.json in the project dir, or amend the spec / fix the gate cause first.`,
        isError: true,
        status: "blocked",
        metadata: { systemic_gate: systemic.gate, systemic_count: systemic.count },
      };
    }

    const startingChunkArg = Number(args.starting_chunk);
    const maxChunksArg = Number(args.max_chunks);
    const startingChunk = Number.isFinite(startingChunkArg) && startingChunkArg > 0
      ? Math.floor(startingChunkArg)
      : plan.chunks[0].number;
    const maxChunks = Number.isFinite(maxChunksArg) && maxChunksArg > 0 ? Math.floor(maxChunksArg) : undefined;

    const startedAt = Date.now();
    const result = await runBuildLoop({
      projectDir,
      planPath,
      plan,
      startingChunk,
      maxChunks,
      signal,
      judgmentHook: defaultJudgmentHook,
    });
    const durationMs = Date.now() - startedAt;

    const head =
      `primal_run_build_plan\n` +
      `project_dir: ${projectDir}\n` +
      `plan_path: ${planPath} (${plan.chunks.length} chunks)\n` +
      `starting_chunk: ${startingChunk}${maxChunks ? `, max_chunks: ${maxChunks}` : ""}\n` +
      `status: ${result.status}, lastChunk: ${result.lastChunk}, committed: ${result.chunksCommitted}, duration: ${durationMs}ms\n` +
      (result.haltReason ? `halt: ${result.haltReason}\n` : "") +
      `---\n`;

    const eventTrail = result.events.map(e =>
      `[${(e.elapsedMs / 1000).toFixed(1)}s] [chunk ${e.chunkNumber}/${e.totalChunks}] ${e.type}: ${e.message}`,
    ).join("\n");

    return {
      content: head + eventTrail,
      isError: result.status === "halted",
      metadata: {
        duration_ms: durationMs,
        status: result.status,
        last_chunk: result.lastChunk,
        chunks_committed: result.chunksCommitted,
        halt_reason: result.haltReason || undefined,
      },
    };
  },
};
