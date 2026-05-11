/**
 * primal_build_resume + primal_build_status — companion tools to
 * primal_run_build_plan that handle resume / inspection of in-flight or
 * halted orchestrations.
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ToolDefinition, ToolResult } from "../../types.js";
import { parsePlanFile } from "../plan-parser.js";
import { isFeatureEnabled, FEATURE_FLAG_ENV } from "../tool.js";
import { defaultJudgmentHook } from "../chunk-review/judgment-hook.js";
import { startOrchestration, listActive } from "./manager.js";
import { readProjectState } from "./resume.js";
import { listAll as listRegistry } from "./registry.js";

const FEATURE_FLAG_BLOCK_MESSAGE =
  `BLOCKED — gated behind the ${FEATURE_FLAG_ENV} env flag, which is currently OFF. ` +
  `To re-enable: unset ${FEATURE_FLAG_ENV} (or set to any non-disabling value) and restart.`;

function resolveProjectDir(raw: unknown): string | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  return isAbsolute(s) ? s : resolve(process.cwd(), s);
}

// ── primal_build_status ───────────────────────────────────────────────────

export const primalBuildStatusTool: ToolDefinition = {
  name: "primal_build_status",
  description:
    "Inspect the state of one or all build orchestrations. Pass `project_dir` to check a " +
    "specific project; omit it to list every known orchestration (active + halted). Returns " +
    "current phase, chunk progress, halt reason if halted, and whether resume is possible.",
  parameters: {
    type: "object",
    properties: {
      project_dir: {
        type: "string",
        description: "Absolute path to a project directory. Optional. When omitted, returns a list of all known orchestrations.",
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const projectDirRaw = args.project_dir as unknown;
    if (projectDirRaw) {
      const projectDir = resolveProjectDir(projectDirRaw);
      if (!projectDir) return { content: "Invalid project_dir.", isError: true };
      const info = readProjectState(projectDir);
      if (!info) {
        return { content: `No orchestrator state found at ${projectDir}. Either no build has run there, or it completed cleanly.` };
      }
      const s = info.state;
      const lines = [
        `project_dir: ${s.projectDir}`,
        `op_id: ${s.opId}`,
        `phase: ${s.phase}`,
        `chunks: ${s.chunksCommitted}/${s.totalChunks} committed (current: chunk ${s.currentChunk}, resume-at: chunk ${s.resumeAtChunk})`,
        `started: ${s.startedAt}`,
        `updated: ${s.updatedAt}`,
      ];
      if (s.haltReason) lines.push(`halt_gate: ${s.haltGate}`, `halt_reason: ${s.haltReason}`);
      if (s.phase === "halted") lines.push(`Resumable: call primal_build_resume({project_dir: "${s.projectDir.replace(/\\/g, "/")}"}).`);
      if (s.phase === "complete") lines.push(`Complete: review LAUNCH_READINESS.md before deploying.`);
      if (!info.planExists) lines.push(`WARNING: plan file at ${s.planPath} is missing — resume will fail.`);
      return { content: lines.join("\n"), metadata: { phase: s.phase, op_id: s.opId, resume_at_chunk: s.resumeAtChunk } };
    }

    // List mode.
    const inMemory = listActive();
    const onDisk = listRegistry();
    const lines: string[] = [];
    lines.push(`Active orchestrations (in-memory): ${inMemory.length}`);
    for (const o of inMemory) {
      lines.push(`  ${o.opId} @ ${o.projectDir} (started ${new Date(o.startedAt).toISOString()})`);
    }
    lines.push(`Registered orchestrations (on disk): ${onDisk.length}`);
    for (const e of onDisk) {
      lines.push(`  ${e.opId} @ ${e.projectDir} (registered ${e.registeredAt})`);
    }
    return { content: lines.join("\n"), metadata: { in_memory: inMemory.length, on_disk: onDisk.length } };
  },
};

// ── primal_build_resume ───────────────────────────────────────────────────

export const primalBuildResumeTool: ToolDefinition = {
  name: "primal_build_resume",
  description:
    "Resume a halted build orchestration. Reads the project's persisted state, picks up at the " +
    "chunk after the last committed one, and kicks off a fresh orchestrator op. Returns the " +
    "new op_id immediately; live progress streams to the AGENTS sidebar.\n\n" +
    "Use this when (a) the user wants to continue a paused build, (b) LAX restarted and the " +
    "auto-resume didn't fire, or (c) a halt was due to a transient issue and the user has " +
    "fixed it externally.",
  parameters: {
    type: "object",
    properties: {
      project_dir: {
        type: "string",
        description: "Absolute path to the project directory of the build to resume.",
      },
      starting_chunk: {
        type: "number",
        description: "Optional override for which chunk to resume at. Defaults to the persisted resume_at_chunk (last committed + 1).",
      },
    },
    required: ["project_dir"],
  },
  async execute(args): Promise<ToolResult> {
    if (!isFeatureEnabled()) return { content: FEATURE_FLAG_BLOCK_MESSAGE, isError: true, status: "blocked" };

    const projectDir = resolveProjectDir(args.project_dir);
    if (!projectDir) return { content: "primal_build_resume requires 'project_dir'.", isError: true };

    const info = readProjectState(projectDir);
    if (!info) {
      return {
        content: `No orchestrator state at ${projectDir}. Nothing to resume. To start fresh, call primal_run_build_plan.`,
        isError: true,
      };
    }
    const s = info.state;
    if (s.phase === "complete") {
      return { content: `Build at ${projectDir} is already complete. Nothing to resume.` };
    }
    if (!info.planExists || !existsSync(s.planPath)) {
      return { content: `Plan file missing: ${s.planPath}. Cannot resume.`, isError: true };
    }

    let plan;
    try {
      plan = parsePlanFile(s.planPath);
    } catch (e) {
      return { content: `plan parse failed: ${(e as Error).message}`, isError: true };
    }

    const overrideArg = Number(args.starting_chunk);
    const startingChunk = Number.isFinite(overrideArg) && overrideArg > 0
      ? Math.floor(overrideArg)
      : s.resumeAtChunk;

    const sessionId = typeof args._sessionId === "string" ? args._sessionId : s.sessionId;

    const kick = startOrchestration({
      sessionId,
      projectDir,
      planPath: s.planPath,
      plan,
      startingChunk,
      maxChunks: s.maxChunks ?? undefined,
      judgmentHook: defaultJudgmentHook,
    });

    return {
      content: kick.initialMessage + `\nResumed from prior state — last committed: chunk ${s.chunksCommitted ? s.currentChunk : "none"}, halt reason was: ${s.haltReason || "(none)"}.`,
      status: "running",
      session_id: kick.opId,
      metadata: {
        op_id: kick.opId,
        project_dir: projectDir,
        resumed: true,
        starting_chunk: startingChunk,
        prior_halt_reason: s.haltReason,
      },
    };
  },
};
