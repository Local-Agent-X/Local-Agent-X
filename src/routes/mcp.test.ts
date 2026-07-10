import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { setAriRequired } from "../ari-kernel/state.js";
import { getRuntimeConfig, loadConfig, setRuntimeConfig } from "../config.js";
import { setUnconfinedHostAcknowledgement } from "../sandbox/index.js";
import type { ToolDefinition, ToolResult } from "../types.js";
import { handleMcpRoutes } from "./mcp.js";

function makeReq(body: unknown): Readable & { headers: Record<string, string> } {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as Readable & { headers: Record<string, string> };
  req.headers = {};
  return req;
}

function makeRes() {
  const res = {
    statusCode: 0,
    body: "",
    writeHead(status: number) { res.statusCode = status; return res; },
    end(chunk?: string) { if (chunk) res.body = chunk; return res; },
  };
  return res;
}

describe("MCP call-context provenance", () => {
  let dataDir: string;
  let previousDataDir: string | undefined;
  let previousMode: string | undefined;
  let previousRuntime: ReturnType<typeof getRuntimeConfig>;

  beforeAll(() => {
    setAriRequired(false);
    previousDataDir = process.env.LAX_DATA_DIR;
    previousMode = process.env.LAX_SANDBOX;
    previousRuntime = getRuntimeConfig();
    dataDir = mkdtempSync(join(tmpdir(), "lax-mcp-context-"));
    process.env.LAX_DATA_DIR = dataDir;
    process.env.LAX_SANDBOX = "host";
    setRuntimeConfig(loadConfig());
    setUnconfinedHostAcknowledgement(false);
  });

  afterAll(() => {
    setAriRequired(true);
    setRuntimeConfig(previousRuntime);
    if (previousDataDir === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = previousDataDir;
    if (previousMode === undefined) delete process.env.LAX_SANDBOX; else process.env.LAX_SANDBOX = previousMode;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("forces API privileges even when the body supplies a chat-style session id", async () => {
    const execute = vi.fn(async (): Promise<ToolResult> => ({ content: "SHELL_EXECUTED" }));
    const shell = {
      name: "shell",
      description: "test shell alias",
      parameters: { type: "object", properties: { command: { type: "string" } } },
      execute,
    } as unknown as ToolDefinition;
    const req = makeReq({ name: "shell", arguments: { command: "echo ok" }, sessionId: "chat-user-session" });
    const res = makeRes();
    const ctx = {
      allAgentTools: [shell],
      security: undefined,
      toolPolicy: undefined,
      rbac: undefined,
      getActiveOnEvent: () => undefined,
    } as unknown as Parameters<typeof handleMcpRoutes>[4];

    const handled = await handleMcpRoutes(
      "POST",
      new URL("http://127.0.0.1/api/mcp/call"),
      req as unknown as Parameters<typeof handleMcpRoutes>[2],
      res as unknown as Parameters<typeof handleMcpRoutes>[3],
      ctx,
      "operator",
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(execute).not.toHaveBeenCalled();
    expect(res.body).toMatch(/effective mode.*host/i);
    expect(res.body).not.toContain("SHELL_EXECUTED");
  });
});
