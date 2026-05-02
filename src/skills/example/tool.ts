/**
 * Example skill tool — wiring proof for the skill-bundle discovery
 * system. Returns a static ping/pong response. Real skills replace this
 * once legacy tools migrate.
 *
 * Pattern:
 *   - Default-export a ToolDefinition (the discoverer reads `default` or
 *     a named `tool` export).
 *   - Same shape as any tool in src/tools/ — no special runtime contract,
 *     this is just where the source lives.
 */

import type { ToolDefinition } from "../../types.js";

const exampleSkillTool: ToolDefinition = {
  name: "example_skill",
  description:
    "Reference skill bundle that validates the skill-discovery loader. " +
    "Returns { ok: true, ping: 'pong' } and nothing else. Do not call " +
    "this from real prompts — it exists only as architectural wiring.",
  parameters: {
    type: "object",
    properties: {},
  },
  async execute() {
    return { content: JSON.stringify({ ok: true, ping: "pong" }) };
  },
};

export default exampleSkillTool;
