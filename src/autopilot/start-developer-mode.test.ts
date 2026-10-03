// Autopilot works on Local Agent X's own source in a worktree and its rounds
// may self_edit there, so starting one is developer-mode work: the tool and
// POST /api/autopilot/start both refuse with developer_mode off and launch
// with it on. Stop and status stay available either way.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

const { createNamedWorktree, runAutopilotLoop } = vi.hoisted(() => ({
  createNamedWorktree: vi.fn((name: string, branch: string) => ({ path: `/worktrees/${name}`, branch, baseBranch: "main" })),
  runAutopilotLoop: vi.fn(async () => undefined),
}));
vi.mock("../agency/worktree.js", () => ({ createNamedWorktree }));
vi.mock("./lock.js", () => ({
  acquireLock: vi.fn(() => null),
  registerExitCleanup: vi.fn(),
  releaseLock: vi.fn(),
  readLock: vi.fn(() => null),
}));
vi.mock("./loop.js", () => ({
  runAutopilotLoop,
  requestStop: vi.fn(() => true),
  getActiveAutopilotOp: vi.fn(() => undefined),
  listActiveAutopilotOps: vi.fn(() => []),
}));
vi.mock("../agent-request/index.js", () => ({
  resolveProvider: vi.fn(async () => ({ provider: "anthropic", apiKey: "test-key", model: "test-model" })),
}));

const { setSetting } = await import("../settings.js");
const { autopilotStartTool, autopilotStatusTool, setAutopilotToolsContext } = await import("./tools.js");
const { handleAutopilotRoutes } = await import("../routes/autopilot.js");

let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), "autopilot-devmode-"));
  setAutopilotToolsContext(async () => ({
    config: {} as never,
    apiKey: "test-key",
    model: "test-model",
    provider: "anthropic",
    allTools: [],
    workspaceDir: join(dataDir, "operations"),
  }));
});
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));
afterEach(() => {
  setSetting("developer_mode", false);
  createNamedWorktree.mockClear();
  runAutopilotLoop.mockClear();
});

const START = { topic: "fix cron edge cases", scope: ["src/cron/"] };

async function postStart(): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = Readable.from([Buffer.from(JSON.stringify(START))]) as Readable & { headers: Record<string, string> };
  req.headers = {};
  const res = {
    statusCode: 0,
    body: "",
    writeHead(status: number) { res.statusCode = status; return res; },
    end(chunk?: string) { if (chunk) res.body = chunk; return res; },
  };
  const ctx = { config: {}, secretsStore: undefined, dataDir, allAgentTools: [] };
  type Args = Parameters<typeof handleAutopilotRoutes>;
  await handleAutopilotRoutes(
    "POST", new URL("http://127.0.0.1/api/autopilot/start"),
    req as unknown as Args[2], res as unknown as Args[3], ctx as unknown as Args[4], "operator",
  );
  return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
}

describe("autopilot_start requires developer_mode", () => {
  it("the tool refuses with developer_mode off and creates no worktree", async () => {
    const result = await autopilotStartTool.execute(START);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("requires developer_mode");
    expect(createNamedWorktree).not.toHaveBeenCalled();
    expect(runAutopilotLoop).not.toHaveBeenCalled();
  });

  it("the tool launches with developer_mode on", async () => {
    setSetting("developer_mode", true);
    const result = await autopilotStartTool.execute(START);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Autopilot launched");
    expect(runAutopilotLoop).toHaveBeenCalledTimes(1);
  });

  it("POST /api/autopilot/start answers 403 with developer_mode off", async () => {
    const { status, body } = await postStart();
    expect(status).toBe(403);
    expect(String(body.reason)).toContain("requires developer_mode");
    expect(createNamedWorktree).not.toHaveBeenCalled();
  });

  it("POST /api/autopilot/start launches with developer_mode on", async () => {
    setSetting("developer_mode", true);
    const { status, body } = await postStart();
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(runAutopilotLoop).toHaveBeenCalledTimes(1);
  });

  it("autopilot_status stays available with developer_mode off", async () => {
    const result = await autopilotStatusTool.execute({});
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("No active autopilot ops");
  });
});

// The description is what tool_search scores (a substring match per query
// word) and what the model reads. It used to offer "work on Y for the next 30
// minutes" as a trigger, which matches everyday requests about the user's own
// projects, none of which it can touch — so no such phrase may come back, not
// even as a counter-example.
describe("autopilot_start is described as work on Local Agent X itself", () => {
  it("names its scope, disclaims the user's own projects, and carries no everyday trigger", () => {
    for (const text of [autopilotStartTool.description, autopilotStartTool.compactDescription ?? ""]) {
      expect(text).toContain("Local Agent X's OWN source");
      expect(text).toContain("developer_mode");
      expect(text).not.toMatch(/minutes|work on/i);
    }
    expect(autopilotStartTool.description).toContain("NOT for the user's own projects, websites");
    expect(autopilotStartTool.compactDescription).toContain("never for their own projects or websites");
  });
});
