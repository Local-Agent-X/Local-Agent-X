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
import { parseScenarioText } from "../auto-build/scenario-scorer/parser.js";

const PROJECT_DESCRIPTION =
  "The project's folder name, the same bare name its build uses (`workspace/apps/<name>`), e.g. `petbook`.";

function failure(e: unknown): ToolResult {
  if (e instanceof HoldoutError) return { content: e.message, isError: true };
  throw e;
}

/**
 * The shape the build's judge can run (auto-build/scenario-scorer/parser.ts).
 * The tool used to ask for "plain prose", the judge needs numbered steps, and
 * nothing checked one against the other: every scenario of two builds was a
 * paragraph the judge skipped (2026-11-26).
 */
export const SCENARIO_FORMAT = [
  "# Scenario: <short name>",
  "",
  "**Persona:** <who is doing this>",
  "**Context:** <what is true when they start>",
  "**Steps:**",
  "1. <one thing they do in the app, as they would do it>",
  "2. <the next thing>",
  "",
  "**Satisfaction criteria:**",
  "- <what they see when it worked, specifically>",
].join("\n");

/** Why the judge could not run this text, or null when it can. */
export function untestableReason(content: string): string | null {
  try {
    parseScenarioText(content, "scenario");
    return null;
  } catch {
    return "it has no `**Steps:**` list";
  }
}

export const holdoutWriteTool: ToolDefinition = {
  name: "holdout_write",
  compactDescription: "Write one held-out acceptance scenario for a build; builders can never read it.",
  description:
    "Write one held-out acceptance scenario for a project's build: the person, the steps they take in the running app, " +
    "and what they should see, in plain words, in this shape (the build's judge performs the numbered steps, so a " +
    "scenario without them is refused):\n\n" + SCENARIO_FORMAT + "\n\n" +
    "Scenarios are written from the spec before any code, then sealed with `holdout_seal`. They are kept " +
    "outside the project, and no agent (you included, after this call) can read them: only the build's judge scores " +
    "the running app against them. Calling it again with the same filename replaces that scenario, until the suite " +
    "is sealed; after that, only a scenario the judge reported it cannot run may be replaced.",
  parameters: {
    type: "object",
    properties: {
      project: { type: "string", description: PROJECT_DESCRIPTION },
      filename: { type: "string", description: "A plain file name ending in .md, numbered for the plan to cite: `01-first-pet.md`." },
      content: { type: "string", description: "The scenario, in the shape above: Persona, numbered Steps, Satisfaction criteria." },
    },
    required: ["project", "filename", "content"],
  },
  async execute(args): Promise<ToolResult> {
    const project = String(args.project ?? "").trim();
    const filename = String(args.filename ?? "").trim();
    const content = String(args.content ?? "");
    const why = content.trim() ? untestableReason(content) : null;
    if (why) {
      return { content: `Not written: the build's judge could not run this scenario (${why}). Write it in this shape:\n\n${SCENARIO_FORMAT}`, isError: true };
    }
    try {
      const { replaced } = writeScenario(project, filename, content, { untestable: (existing) => untestableReason(existing) !== null });
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
