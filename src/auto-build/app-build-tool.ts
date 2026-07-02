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
 *      project_dir. After this, the user can run
 *      `run_build_plan({project_dir})` to start the build.
 *
 * Both tools gated behind LAX_AUTO_BUILD_ENABLED — same flag the
 * build-plan tool uses. The /app-build half + build half share one
 * graduation cycle.
 *
 * Memory integration is automatic: the agent is the conversation host,
 * so anything captured during planning routes through LAX's existing
 * memory system without us doing anything here.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, dirname, basename } from "node:path";
import type { ToolDefinition, ToolResult } from "../types.js";
import { isFeatureEnabled, FEATURE_FLAG_ENV } from "./tool.js";
import { loadSkillBody } from "./skill-bodies.js";
import { parsePlanText } from "./plan-parser.js";
import { projectsDir, resolveProjectDir } from "./project-paths.js";
import { verifyWriteLanded } from "../tools/verify.js";

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
    "artifacts (spec/, scenarios/, twins/, plan.md) into a new project directory. After that, " +
    "call `run_build_plan` to start the actual code build.\n\n" +
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
    let methodology: string;
    try {
      methodology = loadSkillBody("app-build");
    } catch (e) {
      return {
        content: `start_app_build failed: ${(e as Error).message}`,
        isError: true,
      };
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
      `- **After finalize**, suggest the user run \`run_build_plan\` to start ` +
      `the actual code build.\n\n` +
      `---\n\n` +
      `# /app-build methodology\n\n${methodology}`;

    return { content: framing };
  },
};

// ── finalize_app_build ────────────────────────────────────────────────────

interface ScenarioInput {
  filename: string;
  content: string;
}

interface TwinInput {
  filename: string;
  content: string;
}

export const finalizeAppBuildTool: ToolDefinition = {
  name: "finalize_app_build",
  description:
    "Materialize an app-build planning conversation into project artifacts. Call this " +
    "AFTER the planning conversation (opened with `start_app_build`) is complete and the " +
    "user has signed off on the plan. Writes the spec docs, scenarios, optional twins, " +
    "and plan.md atomically into a new project directory.\n\n" +
    "The project directory must NOT already exist — this tool will not overwrite. After " +
    "successful finalize, suggest the user run `run_build_plan({project_dir})` to " +
    "start the build loop.\n\n" +
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
  async execute(args): Promise<ToolResult> {
    if (!isFeatureEnabled()) {
      return { content: FEATURE_FLAG_BLOCK_MESSAGE, isError: true, status: "blocked" };
    }

    const projectDir = resolveProjectDir(args.project_dir);
    if (!projectDir) return { content: "finalize_app_build requires 'project_dir' (bare name resolves to workspace/apps/<name>, or absolute path).", isError: true };

    if (existsSync(projectDir)) {
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

    const scenarios = Array.isArray(args.scenarios) ? (args.scenarios as ScenarioInput[]) : [];
    if (scenarios.length === 0) {
      return { content: "finalize_app_build requires at least one scenario in 'scenarios'.", isError: true };
    }
    const twins = Array.isArray(args.twins) ? (args.twins as TwinInput[]) : [];

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
          `'- **Class:**' / '- **Slice:**' / '- **Done when:**' bullets (see the /app-build ` +
          `methodology). Fix the plan format and re-call finalize_app_build with the full payload.`,
        isError: true,
      };
    }

    const written: string[] = [];
    const queued: Array<{ rel: string; content: string }> = [];

    try {
      mkdirSync(projectDir, { recursive: true });
      mkdirSync(join(projectDir, "spec"), { recursive: true });
      mkdirSync(join(projectDir, "scenarios"), { recursive: true });
      if (twins.length > 0) mkdirSync(join(projectDir, "twins"), { recursive: true });

      queued.push({ rel: "spec/product.md", content: productMd });
      queued.push({ rel: "spec/constitution.md", content: constitutionMd });
      queued.push({ rel: "spec/plan.md", content: planMd });
      if (architectureMd) queued.push({ rel: "spec/architecture.md", content: architectureMd });

      for (const s of scenarios) {
        validateRelPath(s.filename, "scenarios/");
        queued.push({ rel: join("scenarios", s.filename), content: s.content });
      }
      for (const t of twins) {
        validateRelPath(t.filename, "twins/");
        queued.push({ rel: join("twins", t.filename), content: t.content });
      }

      const readme =
        `# ${projectName}\n\n` +
        `Project initialized via \`finalize_app_build\` from a /app-build planning session.\n\n` +
        `## Next step\n\n` +
        `Run the build loop:\n\n` +
        `\`\`\`\nrun_build_plan({ project_dir: "${projectDir.replace(/\\/g, "/")}" })\n\`\`\`\n\n` +
        `## Layout\n\n` +
        `- \`spec/\` — product, constitution, plan; the source of truth the building agents read.\n` +
        `- \`scenarios/\` — held-out user-flow tests. **Building agents must never read this.**\n` +
        (twins.length > 0 ? `- \`twins/\` — in-process fakes for external services.\n` : "");
      queued.push({ rel: "README.md", content: readme });
    } catch (e) {
      return {
        content: `finalize_app_build failed during mkdir: ${(e as Error).message}. Partial files may remain at ${projectDir}.`,
        isError: true,
      };
    }

    for (const item of queued) {
      const abs = join(projectDir, item.rel);
      try {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, item.content);
      } catch (e) {
        return {
          content: `finalize_app_build failed writing ${item.rel}: ${(e as Error).message}. Partial files may remain at ${projectDir}.`,
          isError: true,
        };
      }
      const verified = verifyWriteLanded(abs);
      if (!verified.ok) {
        return {
          content: `finalize_app_build verify failed for ${item.rel}: ${verified.reason}. Partial files may remain at ${projectDir}.`,
          isError: true,
        };
      }
      written.push(item.rel.replace(/\\/g, "/"));
    }

    return {
      content:
        `App-build artifacts written to ${projectDir}.\n\n` +
        `Wrote ${written.length} files:\n` +
        written.map(w => `  - ${w}`).join("\n") + `\n\n` +
        `Next: call \`run_build_plan({ project_dir: "${projectDir.replace(/\\/g, "/")}" })\` to start the build loop.`,
      metadata: { project_dir: projectDir, files_written: written.length, scenario_count: scenarios.length, twin_count: twins.length },
    };
  },
};

// ── helpers ───────────────────────────────────────────────────────────────

/**
 * Reject filenames with path traversal (../, absolute paths). Each
 * scenario/twin filename must be a single relative path component or
 * a forward path under the given prefix — no escaping the project dir.
 */
function validateRelPath(name: string, prefix: string): void {
  if (!name || typeof name !== "string") throw new Error(`${prefix} entry: filename missing`);
  if (name.includes("..")) throw new Error(`${prefix}${name}: path traversal not allowed`);
  if (isAbsolute(name)) throw new Error(`${prefix}${name}: absolute paths not allowed`);
  if (name.startsWith("/") || name.startsWith("\\")) throw new Error(`${prefix}${name}: leading slash not allowed`);
}
