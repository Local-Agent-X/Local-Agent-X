// Autopilot rounds edit and build this install's own source, which needs
// developer_mode. When the user turns it off mid-run, through either path that
// writes the setting (POST /api/settings from Settings, or an approved `setting`
// call), the round in flight is cancelled and nothing from it is validated
// (the build runs the round's code) or committed to the autopilot branch.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Operation } from "./operation-types.js";
import type { AutopilotConfig } from "./types.js";

const mocks = vi.hoisted(() => {
  const signals: Array<AbortSignal | undefined> = [];
  return {
    signals,
    runAutopilotRound: vi.fn((_deps: unknown, opts: { signal?: AbortSignal }) => new Promise((resolve) => {
      signals.push(opts.signal);
      const end = (stopReason: string) => resolve({
        output: "", autopilotDone: false, doneReason: null, stopReason, selfEditCallsThisRound: 0, durationMs: 1,
      });
      opts.signal?.addEventListener("abort", () => end("abort"));
      // A round nobody cancels ends on its own, so a missing cancel fails an
      // assertion below instead of the test timeout.
      setTimeout(() => end("end_turn"), 1_500);
    })),
    validateRound: vi.fn(async () => ({ outcome: "passed", filesChanged: ["src/cron/x.ts"], detail: "", oversizedFiles: [] })),
    commitRound: vi.fn(() => "abc12345"),
    runEndOfShiftBootProof: vi.fn(async () => ({ status: "passed", detail: "ok", durationMs: 1 })),
    broadcastAll: vi.fn(() => 1),
  };
});

vi.mock("./round-agent.js", () => ({ runAutopilotRound: mocks.runAutopilotRound }));
vi.mock("./validate.js", () => ({
  validateRound: mocks.validateRound,
  partitionByScope: (files: string[]) => ({ inScope: files, outOfScope: [] }),
}));
vi.mock("./commit.js", () => ({ commitRound: mocks.commitRound }));
vi.mock("./boot-proof.js", () => ({ runEndOfShiftBootProof: mocks.runEndOfShiftBootProof }));
vi.mock("./lock.js", () => ({ releaseLock: vi.fn() }));
vi.mock("../chat-ws/index.js", () => ({ broadcastAll: mocks.broadcastAll }));

const { runAutopilotLoop, haltAutopilotsIfDeveloperModeOff } = await import("./loop.js");
const { setSetting } = await import("../settings.js");
const { settingTool } = await import("../tools/setting-tool.js");
const { handlePreferencesRoutes } = await import("../routes/settings/preferences.js");
const { loadConfig, setRuntimeConfig } = await import("../config.js");

const OPERATOR_TOKEN = "operator-token";
let workspaceDir: string;

beforeAll(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "autopilot-devmode-halt-"));
  const config = loadConfig();
  config.authToken = OPERATOR_TOKEN;
  setRuntimeConfig(config);
});
afterAll(() => rmSync(workspaceDir, { recursive: true, force: true }));
afterEach(() => {
  setSetting("developer_mode", false);
  mocks.signals.length = 0;
  for (const m of [mocks.runAutopilotRound, mocks.validateRound, mocks.commitRound, mocks.runEndOfShiftBootProof, mocks.broadcastAll]) m.mockClear();
});

function startRun(maxRounds = 3): { op: Operation; done: Promise<void> } {
  const id = `op_ap_test_${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(join(workspaceDir, id), { recursive: true });
  const autopilot: AutopilotConfig = {
    topic: "fix cron edge cases", scope: ["src/cron/"], durationMs: 60_000, maxRounds, maxNoopRounds: 2,
    maxSelfEditCalls: 5, withTests: false, worktreePath: "/tmp/wt", worktreeName: "autopilot-test",
    branchName: "autopilot/test/1", baseBranch: "main", buildCommand: "npm run build", buildTimeoutMs: 60_000,
    testCommand: "npm test", testTimeoutMs: 60_000, fileSizeLimit: 400,
  };
  const op: Operation = {
    id, goal: autopilot.topic, summary: "", phases: [], status: "running", createdAt: Date.now(),
    currentPhase: 0, sharedState: {}, events: [], autopilot, autopilotRounds: [],
  };
  const deps = { config: {} as never, apiKey: "k", model: "m", provider: "anthropic" as const, allTools: [], workspaceDir };
  return { op, done: runAutopilotLoop(op, deps) };
}

async function roundInFlight(): Promise<void> {
  await vi.waitFor(() => expect(mocks.runAutopilotRound).toHaveBeenCalledTimes(1));
}

async function postSettings(body: Record<string, unknown>): Promise<number> {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as Readable & { headers: Record<string, string> };
  req.headers = { authorization: `Bearer ${OPERATOR_TOKEN}` };
  const res = { statusCode: 0, writeHead(s: number) { res.statusCode = s; return res; }, end() { return res; } };
  type Args = Parameters<typeof handlePreferencesRoutes>;
  await handlePreferencesRoutes(
    "POST", new URL("http://127.0.0.1/api/settings"),
    req as unknown as Args[2], res as unknown as Args[3], { dataDir: workspaceDir } as unknown as Args[4], "operator",
  );
  return res.statusCode;
}

function expectHaltedWithoutLanding(op: Operation): void {
  expect(mocks.signals[0]?.aborted).toBe(true);
  expect(mocks.validateRound).not.toHaveBeenCalled();
  expect(mocks.commitRound).not.toHaveBeenCalled();
  expect(mocks.runEndOfShiftBootProof).not.toHaveBeenCalled();
  expect(mocks.runAutopilotRound).toHaveBeenCalledTimes(1);
  expect(op.status).toBe("cancelled");
  expect(op.events.some((e) => e.message.includes("developer_mode is off"))).toBe(true);
  expect(op.events.some((e) => e.message.includes("Stopped (developer mode turned off)"))).toBe(true);
}

describe("autopilot stops when developer_mode turns off", () => {
  it("turning it off in Settings cancels the round in flight; nothing is validated or committed", async () => {
    setSetting("developer_mode", true);
    const { op, done } = startRun();
    await roundInFlight();

    expect(await postSettings({ developer_mode: false })).toBe(200);
    await done;

    expectHaltedWithoutLanding(op);
    expect(mocks.broadcastAll).toHaveBeenCalledWith({ type: "settings_changed", settings: { developer_mode: false } });
  });

  it("turning it off through the `setting` tool does the same", async () => {
    setSetting("developer_mode", true);
    const { op, done } = startRun();
    await roundInFlight();

    const result = await settingTool.execute({ field: "developer_mode", value: false });
    expect(result.isError).toBeFalsy();
    await done;

    expectHaltedWithoutLanding(op);
    expect(mocks.broadcastAll).toHaveBeenCalledWith({ type: "settings_changed", settings: { developer_mode: false } });
  });

  it("turned off while the round validates, the passed round is not committed", async () => {
    setSetting("developer_mode", true);
    mocks.validateRound.mockImplementationOnce(async () => {
      setSetting("developer_mode", false);
      return { outcome: "passed", filesChanged: ["src/cron/x.ts"], detail: "", oversizedFiles: [] };
    });
    const { op, done } = startRun();
    await done;

    expect(mocks.validateRound).toHaveBeenCalledTimes(1);
    expect(mocks.commitRound).not.toHaveBeenCalled();
    expect(mocks.runAutopilotRound).toHaveBeenCalledTimes(1);
    expect(op.status).toBe("cancelled");
  });

  it("already off, no round starts", async () => {
    const { op, done } = startRun();
    await done;

    expect(mocks.runAutopilotRound).not.toHaveBeenCalled();
    expect(op.status).toBe("cancelled");
  });

  it("with developer_mode still on, a halt request cancels nothing and rounds commit", async () => {
    setSetting("developer_mode", true);
    const { op, done } = startRun(1);
    await roundInFlight();

    haltAutopilotsIfDeveloperModeOff();
    await done;

    expect(mocks.signals[0]?.aborted).toBe(false);
    expect(mocks.commitRound).toHaveBeenCalledTimes(1);
    expect(op.status).toBe("completed");
  });
});
