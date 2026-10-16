// What a tool runs and what it returns are facts on its policy row
// (shellCommand, output, externalContent), read by every gate through one
// accessor. Before, each gate kept its own list of "the shell tools" and most
// stopped at bash / process_start / process_restart, so app_serve_backend's
// command — a model-authored shell command — passed the destructive floor, the
// publish gate and the per-file delete card unseen.
import { describe, it, expect, beforeAll } from "vitest";
import { TOOL_POLICIES } from "../tool-policy/tool-policies.js";
import { hasCapability, outputOf, shellCommandOf, waitsForShellCommand } from "../tool-registry.js";
import { isDestructiveCommand } from "../approval-decision.js";
import { publishOperations } from "../publish-operation.js";
import { deleteTargetsOf } from "./unnamed-delete-gate.js";
import { isExternalIngestingTool } from "../data-lineage/external.js";
import { collectRuntimeTools } from "../tools/runtime-tool-names.js";
import type { ToolDefinition } from "../types.js";

const spawners = Object.entries(TOOL_POLICIES).filter(([, row]) => row.shellCommand).map(([name]) => name).sort();

describe("a tool's shell command is declared on its row", () => {
  let tools: Map<string, ToolDefinition>;
  beforeAll(async () => { tools = await collectRuntimeTools(); });

  it("every shell-class tool that takes a `command` declares it, so no gate can miss a spawner", () => {
    const undeclared = [...tools.values()]
      .filter((t) => hasCapability(t.name, "shell"))
      .filter((t) => "command" in ((t.parameters as { properties?: object }).properties ?? {}))
      .filter((t) => !TOOL_POLICIES[t.name]?.shellCommand)
      .map((t) => t.name);
    expect(undeclared).toEqual([]);
    expect(spawners).toEqual(["app_serve_backend", "app_serve_frontend", "bash", "process_restart", "process_start"]);
  });

  it("only bash waits for its command to exit", () => {
    expect(spawners.filter(waitsForShellCommand)).toEqual(["bash"]);
  });

  it.each(spawners)("%s: the destructive floor, the publish gate and the delete card all read its command", (tool) => {
    expect(isDestructiveCommand(tool, { command: "git push --force origin main" }), "destructive floor").not.toBeNull();
    expect(publishOperations(tool, { command: "git push origin main" }).length, "publish gate").toBeGreaterThan(0);
    expect(deleteTargetsOf({ name: tool, arguments: JSON.stringify({ command: "rm notes.md" }) }), "delete card").toEqual(["notes.md"]);
  });

  it("a tool that runs no command is read as running none", () => {
    expect(shellCommandOf("read", { command: "rm -rf /" })).toBeUndefined();
    expect(isDestructiveCommand("read", { command: "rm -rf /" })).toBeNull();
  });
});

describe("what a result carries is declared on its row", () => {
  it("command output, fetched bodies, path-read file content and mail", () => {
    for (const t of ["bash", "process_start", "process_restart", "process_status", "process_list", "app_serve_backend", "app_serve_frontend", "app_rebuild"]) {
      expect(outputOf(t), t).toBe("command");
    }
    for (const t of ["http_request", "web_fetch", "ari_http"]) expect(outputOf(t), t).toBe("http-body");
    for (const t of ["read", "glob", "grep", "structural_search"]) expect(outputOf(t), t).toBe("file-content");
    for (const t of ["email_read", "email_search", "email_read_message"]) expect(outputOf(t), t).toBe("mailbox");
  });

  it("external content: a row says so itself; a name with no row is external when an MCP server's or a provider's", () => {
    for (const t of ["web_fetch", "browser", "web_search", "compare_pages", "email_read", "email_folders", "email_delete"]) {
      expect(isExternalIngestingTool(t), t).toBe(true);
    }
    expect(isExternalIngestingTool("read")).toBe(false);
    expect(isExternalIngestingTool("mcp_add_server")).toBe(false); // a local management tool, with a row
    expect(isExternalIngestingTool("mcp_github_search_issues")).toBe(true); // a runtime MCP server tool, no row
    expect(isExternalIngestingTool("WebSearch")).toBe(true);
  });
});
