import { afterEach, describe, expect, it } from "vitest";
import { forgetMcpServerTools, mcpToolFacts, mcpToolName, recordMcpServerTools } from "./tool-facts.js";

afterEach(() => {
  forgetMcpServerTools("github");
  forgetMcpServerTools("slack");
});

describe("MCP tool facts", () => {
  it("knows a connected server's tools under the name they register as", () => {
    recordMcpServerTools("github", [{ name: "create_issue" }, { name: "get_issue", annotations: { readOnlyHint: true } }]);
    expect(mcpToolName("github", "create_issue")).toBe("mcp_github_create_issue");
    expect(mcpToolFacts("mcp_github_create_issue")).toEqual({ serverName: "github", readOnly: false });
    expect(mcpToolFacts("mcp_github_get_issue")).toEqual({ serverName: "github", readOnly: true });
    expect(mcpToolFacts("mcp_github_never_listed")).toBeUndefined();
  });

  it("is a write unless the server says read-only: an absent or false hint is a write", () => {
    recordMcpServerTools("slack", [
      { name: "post_message" },
      { name: "delete_message", annotations: { readOnlyHint: false, destructiveHint: true } },
      { name: "list_channels", annotations: { readOnlyHint: true } },
    ]);
    expect(mcpToolFacts("mcp_slack_post_message")?.readOnly).toBe(false);
    expect(mcpToolFacts("mcp_slack_delete_message")?.readOnly).toBe(false);
    expect(mcpToolFacts("mcp_slack_list_channels")?.readOnly).toBe(true);
  });

  it("a reconnect replaces the listing, and a disconnect forgets only that server", () => {
    recordMcpServerTools("github", [{ name: "old_tool" }]);
    recordMcpServerTools("slack", [{ name: "post_message" }]);
    recordMcpServerTools("github", [{ name: "new_tool" }]);
    expect(mcpToolFacts("mcp_github_old_tool")).toBeUndefined();
    expect(mcpToolFacts("mcp_github_new_tool")).toBeDefined();
    forgetMcpServerTools("github");
    expect(mcpToolFacts("mcp_github_new_tool")).toBeUndefined();
    expect(mcpToolFacts("mcp_slack_post_message")).toBeDefined();
  });
});
