/**
 * start_app_build + finalize_app_build — agent-side wiring for the
 * /app-build planning workflow.
 *
 * Flow (entirely inside LAX, no Claude Code session needed):
 *
 *   1. User types "/app-build <concept>" in LAX chat (or asks to build
 *      a new app/MVP/product from scratch).
 *   2. The agent calls `start_app_build({concept})`. The tool returns the
 *      /app-build SKILL.md body + framing telling the agent to drive the
 *      planning conversation per the methodology, capturing facts to
 *      memory as it goes.
 *   3. The agent asks the user clarifying questions following the
 *      methodology (Goal, Constraints, Scenarios, Plan, etc.).
 *   4. When planning is complete, the agent calls `finalize_app_build`
 *      with the structured payload (spec docs + scenarios + plan).
 *      The tool writes the four artifacts atomically into a new
 *      project_dir and immediately starts the durable orchestrator.
 *
 * Both tools gated behind LAX_AUTO_BUILD_ENABLED — same flag the
 * build-plan tool uses. The /app-build half + build half share one
 * graduation cycle.
 *
 * Memory integration is automatic: the agent is the conversation host,
 * so anything captured during planning routes through LAX's existing
 * memory system without us doing anything here.
 */

import { existsSync, readdirSync } from "node:fs";
import { dirname, basename } from "node:path";
import type { ToolDefinition, ToolResult } from "../types.js";
import { isFeatureEnabled, FEATURE_FLAG_ENV } from "./tool.js";
import { kickoffBuildPlan, type BuildPlanKickoff } from "./kickoff.js";
import { loadSkillBody } from "./skill-bodies.js";
import { parsePlanText } from "./plan-parser.js";
import { projectsDir, resolveProjectDir } from "./project-paths.js";
import { upsertAppBuildWorkflow } from "./workflow-state.js";
import {
  materializeAppBuild,
  type AppBuildMaterializer,
  type ArtifactInput,
} from "./materialize.js";

const FEATURE_FLAG_BLOCK_MESSAGE =
  `BLOCKED — explicitly disabled via the ${FEATURE_FLAG_ENV} env flag (set to 0/false/no/off). ` +
  `The tool runs by default; unset the flag (or set any other value) and restart the LAX server.`;

// ── start_app_build ───────────────────────────────────────────────────────

export const startAppBuildTool: ToolDefinition = {
  name: "start_app_build",
  description:
    "**THIS IS THE /app-build ENTRYPOINT.** Call this tool — NOT `build_app` — whenever the " +
    "user types `/app-build`, says `/appbuild`, asks for an 'app-build session', or asks to " +
    "build a new app/product/MVP/tool/service from a concept using the directed-build " +
    "(spec-first) methodology. `build_app` is a different tool that drops a generated " +
    "web app into `workspace/apps/` without planning — that is NOT what `/app-build` means.\n\n" +
    "When fired, this tool returns the /app-build methodology body — the planning discipline " +
    "you'll follow across the next several turns with the user. Drive the conversation per " +
    "the methodology: gather Goal, Constraints, Files-to-touch, Scenarios, Plan, Out-of-scope. " +
    "Capture durable project facts to long-term memory as they surface. When planning is " +
    "complete and the user has signed off, call `finalize_app_build` to materialize the four " +
    "artifacts (spec/, scenarios/, twins/, plan.md) into a new project directory and start " +
    "the durable background orchestrator in the same tool call.\n\n" +
    "Disambiguation:\n" +
    "- User says `/app-build` or `/appbuild` or 'start an app-build session' → THIS TOOL.\n" +
    "- User says 'plan a new app spec-first', 'kick off a directed build', 'build me a new " +
    "product from a concept' → THIS TOOL.\n" +
    "- User says 'make me a quick landing page', 'throw together a one-page site', or just " +
    "'build app X' with no planning ask → `build_app` is correct, not this tool.\n\n" +
    "Gated behind LAX_AUTO_BUILD_ENABLED env flag.",
  parameters: {
    type: "object",
    properties: {
      concept: {
        type: "string",
        description: "One-paragraph seed from the user: what they want to build. Free-form. " +
          "If the user only said '/app-build' with no seed, pass an empty string and ask " +
          "the user for the concept in your next turn.",
      },
    },
    required: ["concept"],
  },
  async execute(args): Promise<ToolResult> {
    if (!isFeatureEnabled()) {
      return { content: FEATURE_FLAG_BLOCK_MESSAGE, isError: true, status: "blocked" };
    }
    const concept = String(args.concept || "").trim();
    const sessionId = typeof args._sessionId === "string" ? args._sessionId.trim() : "";
    let methodology: string;
    try {
      methodology = loadSkillBody("app-build");
    } catch (e) {
      return {
        content: `start_app_build failed: ${(e as Error).message}`,
        isError: true,
      };
    }

    if (sessionId) {
      try {
        upsertAppBuildWorkflow({ sessionId, phase: "planning" });
      } catch (e) {
        return {
          content: `start_app_build failed to persist workflow state: ${(e as Error).message}`,
          isError: true,
        };
      }
    }

    const framing =
      `# /app-build session opened\n\n` +
      `You are now driving an app-build planning conversation. Follow the methodology ` +
      `body below across the next several turns with the user. The user typed ` +
      (concept ? `"/app-build" with this seed:\n\n> ${concept}\n\n` : `"/app-build" with no seed yet — ask them for the concept in your next reply.\n\n`) +
      `## Discipline reminders\n\n` +
      `- **Lay out the task ledger before your first reply.** Call task_create once per ` +
      `planning stage (Goal, Constraints, Scenarios, Plan, Sign-off) plus a final ` +
      `"finalize + kick off build" step, and mark each with task_update as the ` +
      `conversation completes it. The ledger is what keeps this session moving — ` +
      `without it, nothing catches a stalled turn.\n` +
      `- **Never end a turn on a promise.** If you announce an action ("next I'll draft ` +
      `the plan"), execute it in the SAME turn. A turn may end only on a question for ` +
      `the user or a completed step — never on an unexecuted intention.\n` +
      `- **Capture durable project facts to memory** as they surface (product name, ` +
      `domain, stack, key constraints, who the users are). LAX's memory system runs ` +
      `under you — use it.\n` +
      `- **Drive the conversation per the methodology below.** Don't shortcut. The ` +
      `value of /app-build is the discipline of planning before coding.\n` +
      `- **Don't write any project files yet.** Hold the spec/scenarios/plan in this ` +
      `conversation. When planning is complete (all sections covered + user signs off), ` +
      `call \`finalize_app_build\` with the full structured payload — that tool ` +
      `materializes the four artifacts atomically into the project directory.\n` +
      `- **Finalize starts the build.** Do not ask the user to run another tool after ` +
      `\`finalize_app_build\`; it launches the orchestrator and leaves chat free.\n\n` +
      `---\n\n` +
      `# /app-build methodology\n\n${methodology}`;

    return { content: framing };
  },
};

// ── finalize_app_build ────────────────────────────────────────────────────

export function createFinalizeAppBuildTool(
  overrides: {
    kickoff?: BuildPlanKickoff;
    materialize?: AppBuildMaterializer;
  } = {},
): ToolDefinition {
  const kickoff = overrides.kickoff ?? kickoffBuildPlan;
  const materialize = overrides.materialize ?? materializeAppBuild;
  return {
  name: "finalize_app_build",
  description:
    "Materialize an app-build planning conversation into project artifacts. Call this " +
    "AFTER the planning conversation (opened with `start_app_build`) is complete and the " +
    "user has signed off on the plan. Writes the spec docs, scenarios, optional twins, " +
    "and plan.md atomically into a new project directory, then starts the durable background " +
    "orchestrator. The project directory must NOT already exist — this tool will not overwrite.\n\n" +
    "Gated behind LAX_AUTO_BUILD_ENABLED env flag.",
  parameters: {
    type: "object",
    properties: {
      project_dir: {
        type: "string",
        description: "Either a bare project name (e.g. 'petbook') — resolved to " +
          "`<lax-root>/workspace/apps/<name>` automatically — OR an absolute path to a NEW " +
          "project directory. Must not already exist. **Default convention: bare name.** " +
          "Absolute paths only when the project lives outside LAX's workspace.",
      },
      project_name: {
        type: "string",
        description: "Human-readable project name (e.g. 'Bookwell'). Used in headers.",
      },
      product_md: {
        type: "string",
        description: "Full content of `spec/product.md` — the load-bearing product spec.",
      },
      constitution_md: {
        type: "string",
        description: "Full content of `spec/constitution.md` — the inviolable rules (no silent failures, etc).",
      },
      architecture_md: {
        type: "string",
        description: "Optional. Full content of `spec/architecture.md` if the project has architectural decisions worth capturing separately.",
      },
      plan_md: {
        type: "string",
        description: "Full content of `spec/plan.md` — chunks ordered, classified (trunk/leaf/mixed), with done-when criteria. This is what `run_build_plan` consumes.",
      },
      scenarios: {
        type: "array",
        description: "Held-out scenario files written to `scenarios/`. Each is the user-flow-as-test the building agent will NEVER see. Format: [{filename:'01-...', content:'...'}, ...]",
        items: {
          type: "object",
          properties: {
            filename: { type: "string" },
            content: { type: "string" },
          },
          required: ["filename", "content"],
        },
      },
      twins: {
        type: "array",
        description: "Optional dev-time test twins (in-process fakes for external services) written to `twins/`. Same shape as scenarios.",
        items: {
          type: "object",
          properties: {
            filename: { type: "string" },
            content: { type: "string" },
          },
          required: ["filename", "content"],
        },
      },
    },
    required: ["project_dir", "project_name", "product_md", "constitution_md", "plan_md", "scenarios"],
  },
  async execute(args, signal): Promise<ToolResult> {
    if (!isFeatureEnabled()) {
      return { content: FEATURE_FLAG_BLOCK_MESSAGE, isError: true, status: "blocked" };
    }
    if (signal?.aborted) return cancellationResult();

    const projectDir = resolveProjectDir(args.project_dir);
    if (!projectDir) return { content: "finalize_app_build requires 'project_dir' (bare name resolves to workspace/apps/<name>, or absolute path).", isError: true };

    if (existsSync(projectDir) && readdirSync(projectDir).length > 0) {
      // Refuse to overwrite an existing dir — but name the sanctioned way out.
      // A guard error without a recovery path teaches the model to fall back
      // to raw write/edit, which silently skips scenarios/ materialization.
      const inAppsWorkspace = dirname(projectDir) === projectsDir();
      const recovery = inAppsWorkspace
        ? `If the existing dir is a generated app you're replacing, call ` +
          `app_delete({ id: "${basename(projectDir)}" }) — it stops any running dev server, then ` +
          `recycles the folder — and re-call finalize_app_build. Otherwise pick a new project name.`
        : `Move or delete it manually first (it's outside the LAX apps workspace), or pick a new path.`;
      return {
        content:
          `project_dir already exists: ${projectDir}. finalize_app_build will not overwrite. ${recovery} ` +
          `Do NOT hand-write the artifacts with write/edit instead — that skips the held-out ` +
          `scenarios/ materialization and the build loop's preconditions.`,
        isError: true,
      };
    }

    const projectName = String(args.project_name || "").trim();
    if (!projectName) return { content: "finalize_app_build requires 'project_name'.", isError: true };

    const productMd = String(args.product_md || "").trim();
    const constitutionMd = String(args.constitution_md || "").trim();
    const planMd = String(args.plan_md || "").trim();
    const architectureMd = String(args.architecture_md || "").trim();

    if (!productMd) return { content: "finalize_app_build requires 'product_md'.", isError: true };
    if (!constitutionMd) return { content: "finalize_app_build requires 'constitution_md'.", isError: true };
    if (!planMd) return { content: "finalize_app_build requires 'plan_md'.", isError: true };

    const scenarios = Array.isArray(args.scenarios) ? (args.scenarios as ArtifactInput[]) : [];
    if (scenarios.length === 0) {
      return { content: "finalize_app_build requires at least one scenario in 'scenarios'.", isError: true };
    }
    const twins = Array.isArray(args.twins) ? (args.twins as ArtifactInput[]) : [];

    // Validate plan_md with the SAME parser the build loop uses. A plan
    // that can't parse here would fail at build kickoff anyway — reject it
    // now, while the planning conversation can still fix it.
    try {
      parsePlanText(planMd);
    } catch (e) {
      return {
        content:
          `finalize_app_build rejected plan_md: ${(e as Error).message}\n\n` +
          `The build loop parses chunks from '### Chunk N — Title' headings, each with ` +
          `'- **Class:**' / '- **Slice:**' / '- **Done when:**' bullets (plus an OPTIONAL ` +
          `'- **Files:**' bullet listing the repo-relative paths the chunk will create/edit, ` +
          `comma- or newline-separated) (see the /app-build methodology). Fix the plan format ` +
          `and re-call finalize_app_build with the full payload.`,
        isError: true,
      };
    }

    let written: string[];
    try {
      signal?.throwIfAborted();
      ({ written } = materialize({
        projectDir,
        projectName,
        productMd,
        constitutionMd,
        planMd,
        architectureMd,
        scenarios,
        twins,
        signal,
      }));
    } catch (e) {
      if (signal?.aborted) return cancellationResult(projectDir);
      return {
        content:
          `finalize_app_build materialization failed: ${(e as Error).message}. ` +
          "No project files were committed; fix the input and retry.",
        isError: true,
      };
    }

    const sessionId = typeof args._sessionId === "string" ? args._sessionId.trim() : "";
    if (sessionId) {
      try {
        upsertAppBuildWorkflow({ sessionId, phase: "finalized", projectDir });
      } catch (e) {
        return {
          content:
            `App-build artifacts were written to ${projectDir}, but workflow state could not be persisted: ` +
            `${(e as Error).message}`,
          isError: true,
        };
      }
    }

    const kick = await kickoff({ projectDir, sessionId, signal });
    if (kick.isError || kick.status === "blocked" || kick.status === "error") {
      return {
        content:
          `App-build artifacts were finalized at ${projectDir}, but orchestration did not start.\n\n` +
          `${kick.content}\n\nThe finalized workflow is preserved. Fix the reported blocker, then use ` +
          `\`run_build_plan({ project_dir: "${projectDir.replace(/\\/g, "/")}" })\`.`,
        isError: true,
        status: kick.status,
        metadata: {
          ...kick.metadata,
          project_dir: projectDir,
          files_written: written.length,
          workflow_phase: "finalized",
        },
      };
    }

    const opId = String(kick.metadata?.op_id || kick.session_id || "").trim();
    if (sessionId) {
      try {
        upsertAppBuildWorkflow({ sessionId, phase: "running", projectDir, opId });
      } catch (e) {
        return {
          content:
            `${kick.content}\n\nThe orchestrator started, but its chat workflow link could not be persisted: ` +
            `${(e as Error).message}. Use build_plan_status with ${projectDir} to reconnect.`,
          status: "running",
          session_id: kick.session_id,
          metadata: { ...kick.metadata, workflow_link_error: (e as Error).message },
        };
      }
    }

    return {
      content:
        `App-build artifacts written to ${projectDir}.\n\n` +
        `Wrote ${written.length} files:\n` +
        written.map(w => `  - ${w}`).join("\n") + `\n\n` +
        `${kick.content}`,
      status: "running",
      session_id: kick.session_id,
      metadata: {
        ...kick.metadata,
        project_dir: projectDir,
        files_written: written.length,
        scenario_count: scenarios.length,
        twin_count: twins.length,
      },
    };
  },
  };
}

export const finalizeAppBuildTool = createFinalizeAppBuildTool();

// ── helpers ───────────────────────────────────────────────────────────────

function cancellationResult(projectDir?: string): ToolResult {
  return {
    content: projectDir
      ? `finalize_app_build was cancelled. No partial project was committed at ${projectDir}.`
      : "finalize_app_build was cancelled before materialization.",
    isError: true,
    status: "error",
    metadata: { cancelled: true, ...(projectDir ? { project_dir: projectDir } : {}) },
  };
}
