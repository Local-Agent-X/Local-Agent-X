/**
 * holdout_judge — score the running app against a project's sealed scenarios,
 * on request: a supervised chunk, the whole suite at the finish gates, or the
 * judge's half of the wall probe. The scoring is the phase gate's own
 * (scenario-scorer/phase-gate-runner.ts scoreScenarioFiles): harness code reads
 * the suite, starts the app from `.lax-launch.json`, and a judge model scores it.
 *
 * The caller gets, per scenario, its file name, score, pass or fail, and the
 * judge's reasoning and failed criteria: what the app did, not the scenario's
 * steps. That is the gap a builder is handed (the /greenfield skill,
 * references/holdout.md section 7), never the test itself.
 */
import { basename, join } from "node:path";
import type { ToolDefinition, ToolResult } from "../types.js";
import { listScenarios } from "../holdout/store.js";
import { projectHoldoutDir } from "../holdout/paths.js";
import { resolveProjectDir } from "./project-paths.js";
import { readLaunchSpec, LAUNCH_SPEC_FILENAME } from "./scenario-scorer/launch-spec.js";
import { scoreScenarioFiles } from "./scenario-scorer/phase-gate-runner.js";
import type { ScoreReport } from "./scenario-scorer/types.js";

function line(r: ScoreReport): string {
  const failed = r.failedCriteria.length ? ` Failed: ${r.failedCriteria.join("; ")}.` : "";
  return `- ${basename(r.scenarioPath)}: ${r.passed ? "pass" : "fail"}, ${r.score}/10. ${r.reasoning}${failed}`;
}

export const holdoutJudgeTool: ToolDefinition = {
  name: "holdout_judge",
  compactDescription: "Score the running app against a project's sealed scenarios (all, or named ones).",
  description:
    "Score the running app against a project's sealed held-out scenarios. Starts the app from the project's " +
    `\`${LAUNCH_SPEC_FILENAME}\`, has the judge drive each scenario, and returns per scenario: pass or fail, a 0-10 ` +
    "score, and the judge's reasoning. You never see the scenarios themselves. Use it for a supervised chunk, the " +
    "whole suite at the finish gates, and the judge's half of the wall probe.",
  parameters: {
    type: "object",
    properties: {
      project_dir: { type: "string", description: "The project: a bare name (`workspace/apps/<name>`) or its absolute path." },
      scenarios: {
        type: "array",
        items: { type: "string" },
        description: "Scenario file names from the index to score. Omit to score the whole suite.",
      },
    },
    required: ["project_dir"],
  },
  async execute(args, signal): Promise<ToolResult> {
    const projectDir = resolveProjectDir(args.project_dir);
    if (!projectDir) return { content: "holdout_judge needs `project_dir`.", isError: true };
    const project = basename(projectDir);
    const dir = projectHoldoutDir(project);
    const sealed = dir ? listScenarios(project) : [];
    if (!dir || sealed.length === 0) return { content: `There are no sealed scenarios for ${project}.`, isError: true };
    const wanted = Array.isArray(args.scenarios) && args.scenarios.length > 0 ? args.scenarios.map(String) : sealed;
    const unknown = wanted.filter((f) => !sealed.includes(f));
    if (unknown.length) return { content: `Not in ${project}'s suite: ${unknown.join(", ")}. The index has: ${sealed.join(", ")}.`, isError: true };
    const launch = readLaunchSpec(projectDir);
    if (!launch) {
      return {
        content: `The suite has ${sealed.length} scenarios (${sealed.join(", ")}), but ${projectDir} has no ${LAUNCH_SPEC_FILENAME}, ` +
          "so the judge cannot start the app. Write it (how to start the app and the URL that answers when it is ready), then judge again.",
        isError: true,
      };
    }
    const outcome = await scoreScenarioFiles({ projectDir, launch, scenarioPaths: wanted.map((f) => join(dir, f)), signal });
    if (outcome.kind === "error" || outcome.kind === "no-spec") return { content: `The judge could not run: ${outcome.reason}`, isError: true };
    const passed = outcome.reports.filter((r) => r.passed).length;
    return { content: `Judged ${outcome.reports.length} scenarios for ${project}: ${passed} passed.\n${outcome.reports.map(line).join("\n")}` };
  },
};
