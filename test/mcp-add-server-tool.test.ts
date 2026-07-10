/**
 * Unit tests for the agent-facing mcp_add_server tool (src/tools/mcp-admin-tools.ts).
 *
 * Exercises validation and the missing-secret guidance path — both spawn-free,
 * so no real npx subprocess is launched. The tool shares the MCPManager
 * singleton, so each test seeds it with a temp data dir first to avoid touching
 * the real ~/.lax/mcp.json.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function setup() {
  const { MCPManager, setSecretLookup } = await import("../src/mcp-client/index.js");
  const { createMcpAdminTools } = await import("../src/tools/mcp-admin-tools.js");
  const { __setMcpSandboxBackendForTests } = await import("../src/mcp-client/connection.js");
  // Seed the singleton on a throwaway dir BEFORE the tool resolves it, and
  // make every secret lookup miss so credentialed servers report missing
  // secrets instead of spawning.
  MCPManager.getInstance(mkdtempSync(join(tmpdir(), "lax-mcp-tool-")));
  setSecretLookup(() => undefined);
  __setMcpSandboxBackendForTests("bwrap");
  const tool = createMcpAdminTools().find(t => t.name === "mcp_add_server")!;
  return { tool };
}

describe("mcp_add_server — validation", () => {
  it("rejects an invalid server name without writing config", async () => {
    const { tool } = await setup();
    const r = await tool.execute({ name: "bad name!", command: "npx" });
    expect(r.isError).toBe(true);
    expect(String(r.content)).toMatch(/invalid server name/i);
  });

  it("requires a command", async () => {
    const { tool } = await setup();
    const r = await tool.execute({ name: "github", command: "" });
    expect(r.isError).toBe(true);
    expect(String(r.content)).toMatch(/command is required/i);
  });

  it("requires an explicit execution posture", async () => {
    const { tool } = await setup();
    const r = await tool.execute({ name: "github", command: "npx" });
    expect(r.isError).toBe(true);
    expect(String(r.content)).toMatch(/executionMode must be sandboxed or trusted/i);
  });

  it("rejects trusted mode because an agent cannot grant local trust", async () => {
    const { tool } = await setup();
    const r = await tool.execute({ name: "github", command: "npx", executionMode: "trusted" });
    expect(r.isError).toBe(true);
    expect(String(r.content)).toMatch(/cannot be granted by an agent/i);
  });
});

describe("mcp_add_server — missing-secret guidance", () => {
  it("adds the server and tells the agent to request the missing secret", async () => {
    const { tool } = await setup();
    const r = await tool.execute({
      name: "github",
      command: "npx",
      executionMode: "sandboxed",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${secret:GITHUB_TOKEN}" },
    });
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).toContain("GITHUB_TOKEN");
    expect(String(r.content)).toMatch(/request_secret/);
  });
});
