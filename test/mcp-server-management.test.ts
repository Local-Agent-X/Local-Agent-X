/**
 * Unit tests for the MCP server-management surface that backs the settings
 * "MCP Servers" card (src/routes/mcp-servers.ts → MCPManager).
 *
 * Covers the three behaviors the UI depends on:
 *   1. getServers() lists EVERY configured server (not just connected ones)
 *      with disabled state, redundant flag, and unresolved-secret info.
 *   2. env values are masked for display — placeholder references pass through,
 *      literal inlined values are hidden so a pasted token never reaches the DOM.
 *   3. setServerDisabled() / addServer() / removeServer() round-trip through the
 *      config file.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function freshManager() {
  const { MCPManager } = await import("../src/mcp-client/index.js");
  const dir = mkdtempSync(join(tmpdir(), "lax-mcp-test-"));
  return MCPManager.getInstance(dir);
}

describe("MCPManager.getServers — full config view for the settings UI", () => {
  beforeEach(async () => {
    const { setSecretLookup } = await import("../src/mcp-client/index.js");
    setSecretLookup(() => undefined);
  });

  it("lists every configured server from the default template", async () => {
    const mgr = await freshManager();
    const names = mgr.getServers().map(s => s.name).sort();
    expect(names).toEqual(["github", "postgres"]);
  });

  it("flags a manually-added filesystem server as redundant", async () => {
    // filesystem is no longer seeded in the default template, but the skip
    // guard still applies if a user adds one by hand.
    const mgr = await freshManager();
    mgr.addServer("filesystem", { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"], disabled: true });
    const fs = mgr.getServers().find(s => s.name === "filesystem")!;
    expect(fs.redundant).toBe(true);
    expect(fs.connected).toBe(false);
    expect(fs.toolCount).toBe(0);
  });

  it("surfaces unresolved ${secret:...} references in missingSecrets", async () => {
    const mgr = await freshManager();
    const gh = mgr.getServers().find(s => s.name === "github")!;
    expect(gh.missingSecrets).toContain("GITHUB_TOKEN");
  });

  it("masks literal env values but passes placeholder references through", async () => {
    const mgr = await freshManager();
    mgr.addServer("custom", { command: "node", args: ["server.js"], env: { RAW: "sk-abc123", REF: "${secret:MY_TOKEN}" } });
    const custom = mgr.getServers().find(s => s.name === "custom")!;
    expect(custom.env.RAW).toBe("••••••••");
    expect(custom.env.REF).toBe("${secret:MY_TOKEN}");
  });
});

describe("MCPManager config mutations", () => {
  it("setServerDisabled flips the flag and persists it", async () => {
    const mgr = await freshManager();
    expect(mgr.setServerDisabled("github", false)).toBe(true);
    expect(mgr.getServers().find(s => s.name === "github")!.disabled).toBe(false);
  });

  it("setServerDisabled returns false for an unknown server", async () => {
    const mgr = await freshManager();
    expect(mgr.setServerDisabled("does-not-exist", true)).toBe(false);
  });

  it("addServer then removeServer round-trips through the config", async () => {
    const mgr = await freshManager();
    mgr.addServer("acme", { command: "npx", args: ["-y", "acme-mcp"], disabled: false });
    expect(mgr.getServers().some(s => s.name === "acme")).toBe(true);
    mgr.removeServer("acme");
    expect(mgr.getServers().some(s => s.name === "acme")).toBe(false);
  });
});
