import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getRuntimeConfig, setRuntimeConfig } from "../src/config.js";
import { MCPManager } from "../src/mcp-client/index.js";
import { isMcpTrustedLocally } from "../src/mcp-client/local-trust.js";
import { handleMcpServerRoutes } from "../src/routes/mcp-servers.js";
import type { ServerContext } from "../src/server-context.js";
import type { LAXConfig } from "../src/types.js";
import { mockJsonRequest, mockResponse } from "./helpers/http-mocks.js";

let dataDir: string;
let savedConfig: LAXConfig | null;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "lax-mcp-trust-route-"));
  try { savedConfig = getRuntimeConfig(); } catch { savedConfig = null; }
  setRuntimeConfig({ authToken: "operator-secret", maxRequestBodyBytes: 1_000_000 } as LAXConfig);
});

afterEach(() => {
  if (savedConfig) setRuntimeConfig(savedConfig);
  rmSync(dataDir, { recursive: true, force: true });
});

function context(): ServerContext {
  return { dataDir, broadcastAll: () => {} } as unknown as ServerContext;
}

describe("POST /api/mcp/servers/trust", () => {
  it("rejects unauthenticated approval and accepts the authenticated settings token", async () => {
    const mgr = MCPManager.getInstance(dataDir);
    const config = { command: "node", args: ["server.js"], executionMode: "trusted" as const, disabled: true };
    mgr.addServer("reviewed", config);
    const cap = mockResponse();

    await handleMcpServerRoutes("POST", new URL("http://test/api/mcp/servers/trust"), mockJsonRequest({ name: "reviewed", approved: true }), cap.res, context(), "operator");

    expect(cap.status).toBe(403);
    expect(isMcpTrustedLocally(dataDir, "reviewed", config)).toBe(false);
    const approved = mockResponse();

    await handleMcpServerRoutes(
      "POST",
      new URL("http://test/api/mcp/servers/trust"),
      mockJsonRequest({ name: "reviewed", approved: true }, { authorization: "Bearer operator-secret" }),
      approved.res,
      context(),
      "operator",
    );

    expect(approved.status).toBe(200);
    expect(isMcpTrustedLocally(dataDir, "reviewed", config)).toBe(true);
  });
});
