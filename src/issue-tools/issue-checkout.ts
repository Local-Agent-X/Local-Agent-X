import type { ToolDefinition } from "../types.js";
import { IssueStore } from "../agent-store.js";
import { ok, err } from "./shared.js";

export const issueCheckoutTool: ToolDefinition = {
  name: "issue_checkout",
  description:
    "Lock an issue so only you can work on it. Prevents other agents from picking it up. " +
    "Automatically sets status to in-progress. Returns null if already locked by another agent.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Issue ID (e.g. 'LAX-1')" },
      agentId: { type: "string", description: "Your agent template ID" },
    },
    required: ["id", "agentId"],
  },
  async execute(args) {
    const store = IssueStore.getInstance();
    const result = store.checkout(String(args.id), String(args.agentId));
    if (!result) return err(`Cannot checkout ${args.id} — either not found or locked by another agent`);
    return ok(`Checked out ${result.id}: "${result.title}" — locked to ${args.agentId}`);
  },
};
