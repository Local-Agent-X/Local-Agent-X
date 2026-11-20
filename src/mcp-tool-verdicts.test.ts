// A connected MCP server's tool has no policy row, so every check that reads
// a row needs its own reading of the server's listing. The kernel judged an
// unmarked tool a write ("post") while the committing and mutation checks
// called it neither: a Slack or GitHub post through MCP counted as a write at
// approval time, as "did not commit" for replay safety and failover, and as
// "no progress" for the loop guards. Every check now answers the same.
import { describe, it, expect, afterEach } from "vitest";
import { forgetMcpServerTools, recordMcpServerTools } from "./mcp-client/tool-facts.js";
import { ariActionOf } from "./tool-registry.js";
import { isCommittingCall, isCommittingTool } from "./committing-tool-check.js";
import { isMutationTool, isProgressTool } from "./tool-mutation-check.js";

afterEach(() => forgetMcpServerTools("acme"));

describe("a connected MCP server's tools get one verdict from every check", () => {
  it("a tool the server did not mark read-only is a write everywhere", () => {
    recordMcpServerTools("acme", [{ name: "post_message", annotations: {} }]);
    const name = "mcp_acme_post_message";
    expect(ariActionOf(name, {})).toBe("post");
    expect(isCommittingTool(name)).toBe(true);
    expect(isCommittingCall(name, { text: "hi" })).toBe(true);
    expect(isMutationTool(name)).toBe(true);
  });

  it("a read-only tool is a write nowhere", () => {
    recordMcpServerTools("acme", [{ name: "list_channels", annotations: { readOnlyHint: true } }]);
    const name = "mcp_acme_list_channels";
    expect(ariActionOf(name, {})).toBe("get");
    expect(isCommittingTool(name)).toBe(false);
    expect(isMutationTool(name)).toBe(false);
  });

  it("a server tool the registry holds without listing facts is a write, as the kernel reads it", () => {
    const name = "mcp_acme_unlisted";
    expect(ariActionOf(name, {})).toBe("post");
    expect(isCommittingTool(name)).toBe(true);
    expect(isMutationTool(name)).toBe(true);
  });

  it("an MCP call is never local work for the discovery-loop guard", () => {
    recordMcpServerTools("acme", [{ name: "post_message", annotations: {} }]);
    expect(isProgressTool("mcp_acme_post_message")).toBe(false);
  });
});
