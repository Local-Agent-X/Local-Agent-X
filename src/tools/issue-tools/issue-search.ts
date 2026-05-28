import type { ToolDefinition } from "../../types.js";
import { IssueStore } from "../../agent-store.js";
import { ok } from "./shared.js";

export const issueSearchTool: ToolDefinition = {
  name: "issue_search",
  description: "Search issues by keyword. Searches titles, descriptions, and comments.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
    },
    required: ["query"],
  },
  async execute(args) {
    const store = IssueStore.getInstance();
    const results = store.search(String(args.query || ""));
    if (results.length === 0) return ok("No issues found matching that query.");
    const lines = results.map(i =>
      `${i.id} [${i.status}] ${i.priority} — ${i.title}${i.assignee ? ` (${i.assignee})` : ""}`
    );
    return ok(`${results.length} result(s):\n\n${lines.join("\n")}`);
  },
};
