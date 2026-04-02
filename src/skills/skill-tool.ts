/**
 * Skill Tool — lets the agent list and run user-defined skills.
 *
 * Skills are markdown files at ~/.sax/skills/{name}/SKILL.md
 * The agent can discover them via skill_list, then invoke via skill_run.
 */

import type { ToolDefinition, ToolResult } from "../types.js";
import { getSkillRegistry } from "./skill-loader.js";
import { setSessionAllowedTools, clearSessionAllowedTools } from "../session-policy.js";

export const skillListTool: ToolDefinition = {
  name: "skill_list",
  description: "List all available user-defined skills. Skills are reusable workflows defined as markdown files in ~/.sax/skills/.",
  parameters: { type: "object", properties: {}, required: [] },
  async execute(): Promise<ToolResult> {
    // Reload skills from disk so new/edited skills are visible without restart
    const registry = getSkillRegistry();
    registry.reload();
    const skills = registry.list();
    if (skills.length === 0) return { content: "No skills found. Create one at ~/.sax/skills/my-skill/SKILL.md" };
    const lines = skills.map((s) =>
      `- **${s.metadata.name}** (${s.id})${s.metadata.argumentHint ? ` ${s.metadata.argumentHint}` : ""}\n  ${s.metadata.description}`
    );
    return { content: `${skills.length} skills available:\n\n${lines.join("\n")}` };
  },
};

export const skillRunTool: ToolDefinition = {
  name: "skill_run",
  description:
    "Run a user-defined skill by name. Skills are reusable workflows defined as markdown files. " +
    'Use skill_list first to see available skills. Example: name="deploy", arguments="staging"',
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill name (directory name)" },
      arguments: { type: "string", description: "Arguments to pass to the skill (replaces $ARGUMENTS in the prompt)" },
    },
    required: ["name"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const name = String(args.name || "");
    if (!name) return { content: "Missing required param: name", isError: true };

    // Reload in case skills were added/edited
    const registry = getSkillRegistry();
    registry.reload();
    const skill = registry.get(name);
    if (!skill) {
      const available = registry.list().map((s) => s.id).join(", ");
      return { content: `Skill "${name}" not found. Available: ${available || "(none)"}`, isError: true };
    }

    const prompt = registry.buildPrompt(skill, args.arguments as string | undefined);
    const sessionId = (args._sessionId as string) || "default";

    // Enforce allowed-tools via session policy (stored, enforced by checkSessionPolicy)
    if (skill.metadata.allowedTools?.length) {
      const allowed = new Set([...skill.metadata.allowedTools, "skill_run", "skill_list", "ask_user"]);
      setSessionAllowedTools(sessionId, allowed);
    } else {
      // No restrictions — clear any previous skill restriction
      clearSessionAllowedTools(sessionId);
    }

    return {
      content: `Running skill "${skill.metadata.name}":\n\n${prompt}\n\n[When this skill's task is complete, the tool restriction will be cleared automatically.]`,
      metadata: {
        skillId: skill.id,
        skillName: skill.metadata.name,
        allowedTools: skill.metadata.allowedTools,
        isSkillPrompt: true,
      },
    };
  },
};

export const skillTools: ToolDefinition[] = [skillListTool, skillRunTool];
