/**
 * start_app_build — the entry to a spec-first build: the /greenfield skill.
 *
 * Flow (entirely inside LAX):
 *
 *   1. The user types "/greenfield <idea>" (the slash command inlines the
 *      skill) or asks to build a new app/MVP/product from scratch; the agent
 *      calls this tool, which returns the skill's body and opens the chat's
 *      build workflow in its "planning" phase.
 *   2. The agent interviews the owner, writes `spec/` into
 *      `workspace/apps/<name>`, writes and seals the held-out scenarios
 *      (holdout_write / holdout_seal, src/holdout/), and plans the chunks.
 *   3. On the owner's yes it starts the build with run_build_plan, which links
 *      the build to this chat; holdout_judge scores the running app against
 *      the sealed suite.
 *
 * Switched off only when LAX_AUTO_BUILD_ENABLED is set to 0/false/no/off (the
 * build engine's opt-out flag); it then returns a blocked result saying so.
 * The description does not mention the flag: Grok read "Gated behind" as
 * "off unless set", checked, found it unset, and never called the tool
 * (2026-11-27, tool-description-settings.test.ts).
 */

import type { ToolDefinition, ToolResult } from "../types.js";
import { blocked } from "../tools/result-helpers.js";
import { sessionIdOf } from "../tool-execution/internal-args.js";
import { AUTO_BUILD_DISABLED_RECOVERY, isFeatureEnabled, FEATURE_FLAG_ENV } from "./tool.js";
import { loadSkillBody } from "./skill-bodies.js";
import { upsertAppBuildWorkflow } from "./workflow-state.js";

const FEATURE_FLAG_BLOCK_MESSAGE =
  `BLOCKED — explicitly disabled via the ${FEATURE_FLAG_ENV} env flag (set to 0/false/no/off). ` +
  `The tool runs by default; unset the flag (or set any other value) and restart the LAX server.`;

export const startAppBuildTool: ToolDefinition = {
  name: "start_app_build",
  description:
    "**THE /greenfield ENTRYPOINT.** Call this tool — NOT `build_app` — when the user asks to build a new " +
    "app/product/MVP/tool/service from an idea with a spec first, or types `/greenfield` and the skill is not " +
    "already in this conversation. It returns the /greenfield skill: interview the owner into a spec, write and " +
    "seal held-out scenarios (holdout_write, holdout_seal), plan the chunks, then on the owner's yes start the " +
    "build with run_build_plan and score it with holdout_judge.\n\n" +
    "Disambiguation:\n" +
    "- 'plan a new app spec-first', 'build me a new product from scratch', 'build it autonomously' → THIS TOOL.\n" +
    "- 'make me a quick landing page', 'throw together a one-page site', or 'build app X' with no planning ask → " +
    "`build_app`, not this tool.",
  parameters: {
    type: "object",
    properties: {
      concept: {
        type: "string",
        description: "The user's idea, in their words. Empty when they gave none: then ask for it in your next turn.",
      },
    },
    required: ["concept"],
  },
  async execute(args): Promise<ToolResult> {
    if (!isFeatureEnabled()) {
      return blocked(FEATURE_FLAG_BLOCK_MESSAGE, { layer: "app-build", recovery: AUTO_BUILD_DISABLED_RECOVERY });
    }
    const concept = String(args.concept || "").trim();
    const sessionId = sessionIdOf(args)?.trim() ?? "";
    let skill: string;
    try {
      skill = loadSkillBody("greenfield");
    } catch (e) {
      return { content: `start_app_build failed: ${(e as Error).message}`, isError: true };
    }

    if (sessionId) {
      try {
        upsertAppBuildWorkflow({ sessionId, phase: "planning" });
      } catch (e) {
        return { content: `start_app_build failed to persist workflow state: ${(e as Error).message}`, isError: true };
      }
    }

    const framing =
      `# /greenfield build opened\n\n` +
      (concept ? `The idea, in the user's words:\n\n> ${concept}\n\n` : `The user gave no idea yet: ask for it in your next reply.\n\n`) +
      `## Discipline reminders\n\n` +
      // The task ledger is what the open-steps gate holds a stalled turn to
      // (a model announced next steps in prose and waited, Jul 2026).
      `- **Lay out the task ledger before your first reply.** Call task_create once per phase of the skill ` +
      `below, and mark each with task_update as it completes.\n` +
      `- **Never end a turn on a promise.** If you announce an action, do it in the same turn. A turn ends on ` +
      `a question for the owner or a finished step.\n` +
      `- **Capture durable project facts to memory** as they surface: the product's name, who it is for, the ` +
      `stack, the constraints the owner set.\n\n` +
      `---\n\n# /greenfield\n\n${skill}`;

    return { content: framing };
  },
};
