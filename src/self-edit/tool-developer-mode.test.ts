// self_edit changes Local Agent X's own source, so it runs only with
// developer_mode on — on the sandboxed path and in an autopilot session's
// worktree alike. The `_unsafe` rescue that skipped this check is gone: no
// argument reopens it.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { runSelfEditBypass, runSelfEditInSandbox } = vi.hoisted(() => ({
  runSelfEditBypass: vi.fn(async (_cwd: string, _prompt: string, _signal?: AbortSignal) => ({ content: "bypass ran" })),
  runSelfEditInSandbox: vi.fn(async () => ({ ok: true })),
}));
vi.mock("./bypass-runner.js", () => ({ runSelfEditBypass }));
vi.mock("./sandbox.js", () => ({ runSelfEditInSandbox, formatSandboxResult: () => "sandbox ran" }));
vi.mock("./global-lock.js", () => ({
  acquireGlobalSelfEditLock: vi.fn(async () => ({ acquired: true, nonce: "test-lock" })),
  releaseGlobalSelfEditLock: vi.fn(async () => undefined),
  formatGlobalLockBusy: vi.fn(() => "busy"),
}));
vi.mock("../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.js")>()),
  getRuntimeConfig: () => ({ authToken: "test-token" }),
}));

const { selfEditTool } = await import("./tool.js");
const { setSetting } = await import("../settings.js");
const { executeToolCalls } = await import("../tool-execution/execute-tool.js");
const { setAriRequired } = await import("../ari-kernel/state.js");
const { registerAutopilotSession, unregisterAutopilotSession } = await import("../autopilot/registry.js");

const TASK = "src/routes/settings.ts returns 500 when the theme flips";
const SESSION = "autopilot-round-session";
let worktree: string;
let callSeq = 0;

beforeAll(() => {
  setAriRequired(false);
  worktree = mkdtempSync(join(tmpdir(), "self-edit-devmode-"));
});
afterAll(() => {
  setAriRequired(true);
  rmSync(worktree, { recursive: true, force: true });
});
afterEach(() => {
  setSetting("developer_mode", false);
  unregisterAutopilotSession(SESSION);
  runSelfEditBypass.mockClear();
  runSelfEditInSandbox.mockClear();
});

// Through the real dispatch chain, so the autopilot worktree is stamped the
// way a round agent's call is.
async function dispatchInAutopilot(): Promise<string> {
  registerAutopilotSession(SESSION, "op_test", worktree, 5);
  const msgs = await executeToolCalls(
    [{ id: `self-edit-${callSeq++}`, name: "self_edit", arguments: JSON.stringify({ task: `${TASK} (${callSeq})` }) }],
    new Map([["self_edit", selfEditTool]]), undefined as never, undefined, undefined, undefined, undefined, SESSION,
    undefined, undefined, undefined, undefined, undefined, "local",
  );
  return String(msgs.find((m) => m.role === "tool")?.content ?? "");
}

describe("self_edit requires developer_mode on every path", () => {
  it("refuses the sandboxed path with developer_mode off", async () => {
    const result = await selfEditTool.execute({ task: TASK });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("requires developer_mode");
    expect(runSelfEditInSandbox).not.toHaveBeenCalled();
  });

  it("refuses inside an autopilot session with developer_mode off", async () => {
    const content = await dispatchInAutopilot();
    expect(content).toContain("requires developer_mode");
    expect(runSelfEditBypass).not.toHaveBeenCalled();
  });

  it("refuses a direct call carrying `_unsafe` with developer_mode off", async () => {
    const result = await selfEditTool.execute({ task: TASK, _unsafe: true });
    expect(result.content).toContain("requires developer_mode");
    expect(runSelfEditBypass).not.toHaveBeenCalled();
    expect(runSelfEditInSandbox).not.toHaveBeenCalled();
  });

  it("with developer_mode on, `_unsafe` still takes the gated sandbox, never the bypass", async () => {
    setSetting("developer_mode", true);
    await selfEditTool.execute({ task: TASK, _unsafe: true });
    expect(runSelfEditInSandbox).toHaveBeenCalledTimes(1);
    expect(runSelfEditBypass).not.toHaveBeenCalled();
  });

  it("with developer_mode on, an autopilot session edits in its own worktree", async () => {
    setSetting("developer_mode", true);
    const content = await dispatchInAutopilot();
    expect(content).toContain("bypass ran");
    expect(runSelfEditBypass).toHaveBeenCalledTimes(1);
    expect(runSelfEditBypass.mock.calls[0][0]).toBe(worktree);
  });
});
