/**
 * start_app_build + finalize_app_build — Primal-side wiring for the
 * /app-build planning workflow.
 *
 * Flow (entirely inside LAX, no Claude Code session needed):
 *
 *   1. User types "/app-build <concept>" in LAX chat (or asks to build
 *      a new app/MVP/product from scratch).
 *   2. Primal calls `start_app_build({concept})`. The tool returns the
 *      /app-build SKILL.md body + framing telling Primal to drive the
 *      planning conversation per the methodology, capturing facts to
 *      memory as it goes.
 *   3. Primal asks the user clarifying questions following the
 *      methodology (Goal, Constraints, Scenarios, Plan, etc.).
 *   4. When planning is complete, Primal calls `finalize_app_build`
 *      with the structured payload (spec docs + scenarios + plan).
 *      The tool writes the four artifacts atomically into a new
 *      project_dir. After this, the user can run
 *      `primal_run_build_plan({project_dir})` to start the build.
 *
 * Both tools gated behind PRIMAL_AUTO_BUILD_ENABLED — same flag the
 * build-plan tool uses. The /app-build half + build half share one
 * graduation cycle.
 *
 * Memory integration is automatic: Primal is the conversation host,
 * so anything captured during planning routes through LAX's existing
 * memory system without us doing anything here.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, dirname } from "node:path";
import type { ToolDefinition, ToolResult } from "../types.js";
import { isFeatureEnabled, FEATURE_FLAG_ENV } from "./tool.js";
import { loadSkillBody } from "./skill-bodies.js";
import { resolveProjectDir } from "./project-paths.js";

const FEATURE_FLAG_BLOCK_MESSAGE =
  `BLOCKED — gated behind the ${FEATURE_FLAG_ENV} env flag, which is currently OFF. ` +
  `To enable: set ${FEATURE_FLAG_ENV}=1 and restart the LAX server.`;

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
    "call `primal_run_build_plan` to start the actual code build.\n\n" +
    "Disambiguation:\n" +
    "- User says `/app-build` or `/appbuild` or 'start an app-build session' → THIS TOOL.\n" +
    "- User says 'plan a new app spec-first', 'kick off a directed build', 'build me a new " +
    "product from a concept' → THIS TOOL.\n" +
    "- User says 'make me a quick landing page', 'throw together a one-page site', or just " +
    "'build app X' with no planning ask → `build_app` is correct, not this tool.\n\n" +
    "Gated behind PRIMAL_AUTO_BUILD_ENABLED env flag.",
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
      `- **Capture durable project facts to memory** as they surface (product name, ` +
      `domain, stack, key constraints, who the users are). LAX's memory system runs ` +
      `under you — use it.\n` +
      `- **Drive the conversation per the methodology below.** Don't shortcut. The ` +
      `value of /app-build is the discipline of planning before coding.\n` +
      `- **Don't write any project files yet.** Hold the spec/scenarios/plan in this ` +
      `conversation. When planning is complete (all sections covered + user signs off), ` +
      `call \`finalize_app_build\` with the full structured payload — that tool ` +
      `materializes the four artifacts atomically into the project directory.\n` +
      `- **After finalize**, suggest the user run \`primal_run_build_plan\` to start ` +
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
    "successful finalize, suggest the user run `primal_run_build_plan({project_dir})` to " +
    "start the build loop.\n\n" +
    "Gated behind PRIMAL_AUTO_BUILD_ENABLED env flag.",
  parameters: {
    type: "object",
    properties: {
      project_dir: {
        type: "string",
        description: "Either a bare project name (e.g. 'mygroomtime') — resolved to " +
          "`<lax-root>/workspace/apps/<name>` automatically — OR an absolute path to a NEW " +
          "project directory. Must not already exist. **Default convention: bare name.** " +
          "Absolute paths only when the project lives outside LAX's workspace.",
      },
      project_name: {
        type: "string",
        description: "Human-readable project name (e.g. 'Calenbella'). Used in headers.",
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
        description: "Full content of `spec/plan.md` — chunks ordered, classified (trunk/leaf/mixed), with done-when criteria. This is what `primal_run_build_plan` consumes.",
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
      // Refuse to overwrite an existing dir. Forces user to choose a fresh path.
      return {
        content:
          `project_dir already exists: ${projectDir}. finalize_app_build will not overwrite — ` +
          `pick a new path. If you want to re-run planning into the same path, delete it manually first.`,
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

    const written: string[] = [];
    try {
      mkdirSync(projectDir, { recursive: true });
      mkdirSync(join(projectDir, "spec"), { recursive: true });
      mkdirSync(join(projectDir, "scenarios"), { recursive: true });
      if (twins.length > 0) mkdirSync(join(projectDir, "twins"), { recursive: true });

      writeArtifact(projectDir, "spec/product.md", productMd, written);
      writeArtifact(projectDir, "spec/constitution.md", constitutionMd, written);
      writeArtifact(projectDir, "spec/plan.md", planMd, written);
      if (architectureMd) writeArtifact(projectDir, "spec/architecture.md", architectureMd, written);

      for (const s of scenarios) {
        validateRelPath(s.filename, "scenarios/");
        writeArtifact(projectDir, join("scenarios", s.filename), s.content, written);
      }
      for (const t of twins) {
        validateRelPath(t.filename, "twins/");
        writeArtifact(projectDir, join("twins", t.filename), t.content, written);
      }

      // Convenience: write a README pointing at the next step.
      const readme =
        `# ${projectName}\n\n` +
        `Project initialized via \`finalize_app_build\` from a /app-build planning session.\n\n` +
        `## Next step\n\n` +
        `Run the build loop:\n\n` +
        `\`\`\`\nprimal_run_build_plan({ project_dir: "${projectDir.replace(/\\/g, "/")}" })\n\`\`\`\n\n` +
        `## Layout\n\n` +
        `- \`spec/\` — product, constitution, plan; the source of truth the building agents read.\n` +
        `- \`scenarios/\` — held-out user-flow tests. **Building agents must never read this.**\n` +
        (twins.length > 0 ? `- \`twins/\` — in-process fakes for external services.\n` : "");
      writeArtifact(projectDir, "README.md", readme, written);
    } catch (e) {
      return {
        content: `finalize_app_build failed during write: ${(e as Error).message}. Partial files may remain at ${projectDir}.`,
        isError: true,
      };
    }

    return {
      content:
        `App-build artifacts written to ${projectDir}.\n\n` +
        `Wrote ${written.length} files:\n` +
        written.map(w => `  - ${w}`).join("\n") + `\n\n` +
        `Next: call \`primal_run_build_plan({ project_dir: "${projectDir.replace(/\\/g, "/")}" })\` to start the build loop.`,
      metadata: { project_dir: projectDir, files_written: written.length, scenario_count: scenarios.length, twin_count: twins.length },
    };
  },
};

// ── helpers ───────────────────────────────────────────────────────────────

function writeArtifact(projectDir: string, relPath: string, content: string, written: string[]): void {
  const abs = join(projectDir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  written.push(relPath.replace(/\\/g, "/"));
}

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
