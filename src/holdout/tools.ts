/**
 * holdout_write + holdout_seal: how the chat planning a build writes its
 * held-out scenarios and seals them (the /greenfield skill, phase 4).
 *
 * These are the only way into the suite. Neither takes a path: the store is
 * named by the project, so the seal (security/layer/holdout-seal.ts) can refuse
 * every path that reaches it. Neither echoes a scenario back. After the seal no
 * one can add or change a scenario; only the build's judge reads them.
 */
import type { ToolDefinition, ToolResult } from "../types.js";
import { HoldoutError, isSealed, listScenarios, sealSuite, writeScenario } from "./store.js";

const PROJECT_DESCRIPTION =
  "The project's folder name, the same bare name its build uses (`workspace/apps/<name>`), e.g. `petbook`.";

function failure(e: unknown): ToolResult {
  if (e instanceof HoldoutError) return { content: e.message, isError: true };
  throw e;
}

export const holdoutWriteTool: ToolDefinition = {
  name: "holdout_write",
  compactDescription: "Write one held-out acceptance scenario for a build; builders can never read it.",
  description:
    "Write one held-out acceptance scenario for a project's build, in plain prose: the person, what they do, what they " +
    "should see. Scenarios are written from the spec before any code, then sealed with `holdout_seal`. They are kept " +
    "outside the project, and no agent (you included, after this call) can read them: only the build's judge scores " +
    "the running app against them. Calling it again with the same filename replaces that scenario, until the suite " +
    "is sealed.",
  parameters: {
    type: "object",
    properties: {
      project: { type: "string", description: PROJECT_DESCRIPTION },
      filename: { type: "string", description: "A plain file name ending in .md, numbered for the plan to cite: `01-first-pet.md`." },
      content: { type: "string", description: "The scenario, in prose." },
    },
    required: ["project", "filename", "content"],
  },
  async execute(args): Promise<ToolResult> {
    const project = String(args.project ?? "").trim();
    const filename = String(args.filename ?? "").trim();
    try {
      const { replaced } = writeScenario(project, filename, String(args.content ?? ""));
      const count = listScenarios(project).length;
      return { content: `${replaced ? "Replaced" : "Wrote"} ${filename} for ${project} (${count} scenario${count === 1 ? "" : "s"} so far, not sealed).` };
    } catch (e) {
      return failure(e);
    }
  },
};

export const holdoutSealTool: ToolDefinition = {
  name: "holdout_seal",
  compactDescription: "Seal a build's held-out scenarios: no one can change them after this.",
  description:
    "Seal a project's held-out scenarios once the owner has seen them. After this no scenario can be added or changed, " +
    "and the build's judge scores every chunk against them. Returns the index (file names only) to record in " +
    "`spec/ledger.md`. Sealing twice is harmless.",
  parameters: {
    type: "object",
    properties: { project: { type: "string", description: PROJECT_DESCRIPTION } },
    required: ["project"],
  },
  async execute(args): Promise<ToolResult> {
    const project = String(args.project ?? "").trim();
    try {
      const already = isSealed(project);
      const scenarios = already ? listScenarios(project) : sealSuite(project).scenarios;
      return {
        content: `${already ? "Already sealed" : "Sealed"}: ${scenarios.length} scenario${scenarios.length === 1 ? "" : "s"} for ${project}. ` +
          `Index: ${scenarios.join(", ")}. No agent can read or change them now; the build's judge scores against them.`,
      };
    } catch (e) {
      return failure(e);
    }
  },
};
