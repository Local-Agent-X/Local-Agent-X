import type { ToolDefinition } from "../types.js";
import { IssueStore } from "../agent-store.js";
import { ok, err } from "./shared.js";

export const issueReleaseTool: ToolDefinition = {
  name: "issue_release",
  description: "Release your lock on an issue so other agents can pick it up.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Issue ID" },
      agentId: { type: "string", description: "Your agent template ID" },
    },
    required: ["id", "agentId"],
  },
  async execute(args) {
    const store = IssueStore.getInstance();
    return store.release(String(args.id), String(args.agentId))
      ? ok(`Released lock on ${args.id}`)
      : err(`Cannot release ${args.id} — not found or not locked by you`);
  },
};
