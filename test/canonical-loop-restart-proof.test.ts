import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "canonical-loop-restart-worker.ts");
let dataDir: string;
let ledger: string;

function run(action: "persist" | "resume", opId: string, mutation = "") {
  return spawnSync(process.execPath, ["--import=tsx", fixture, action, opId, ledger, mutation], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LAX_DATA_DIR: dataDir,
      LAX_DISABLE_BACKGROUND_JOBS: "1",
      LAX_DISABLE_OS_KEYCHAIN: "1",
    },
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
}

function childResult<T>(stdout: string): T {
  const marker = stdout.lastIndexOf("@@RESULT@@");
  if (marker < 0) throw new Error(`child result marker missing: ${stdout}`);
  return JSON.parse(stdout.slice(marker + "@@RESULT@@".length)) as T;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "canonical-restart-proof-"));
  ledger = join(dataDir, "external-side-effects.jsonl");
});

afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

describe("canonical delegated recovery across a process restart", () => {
  it("continues the next turn without duplicating a committed side effect", () => {
    const opId = "op_process_restart_proof";
    const processA = run("persist", opId);
    expect(processA.status, processA.stderr).toBe(0);
    expect(childResult<{ state: string; turns: number }>(processA.stdout)).toEqual({
      state: "running",
      turns: 1,
    });

    const processB = run("resume", opId);
    expect(processB.status, processB.stderr).toBe(0);
    const recovered = childResult<{
      state: string;
      attemptCount: number;
      runtimeDescriptor: unknown;
      durableRuntimeSelection: unknown;
      canonicalSessionId: string;
      trackedSessionDuringResume: string;
      trackedSessionAfterTerminal?: string;
      adapterExecutionIdentities: Array<Record<string, unknown>>;
      adapterInputCount: number;
      dispatcherCalls: number;
      resumedTurnIdx: number;
      resumedProviderState: unknown;
      resumedToolResults: number;
      persistedToolResults: number;
      turnIndexes: number[];
      firstTurnToolSummary: unknown;
      finalProviderState: unknown;
      sideEffectCount: number;
      leaseOwner: null;
      leaseExpiresAt: null;
    }>(processB.stdout);

    expect(recovered).toMatchObject({
      state: "succeeded",
      attemptCount: 1,
      runtimeDescriptor: {
        kind: "delegated-op",
        adapter: "lane-default",
        sessionId: "session-across-restart",
      },
      durableRuntimeSelection: {
        adapter: "lane-default",
        model: "restart-proof-model",
        sessionId: "session-across-restart",
      },
      canonicalSessionId: "session-across-restart",
      trackedSessionDuringResume: "session-across-restart",
      adapterExecutionIdentities: [{
        adapterName: "restart-proof-provider",
        adapterVersion: "1",
        checkpointAdapterName: "restart-proof-provider",
        checkpointAdapterVersion: "1",
        cursor: "checkpoint-0",
        providerSession: "provider-session-a",
        configuredModel: "restart-proof-model",
        configuredRuntime: "lane-default",
        canonicalSession: "session-across-restart",
        turnIdx: 1,
        tools: ["write"],
      }],
      adapterInputCount: 1,
      dispatcherCalls: 0,
      resumedTurnIdx: 1,
      resumedProviderState: {
        adapterName: "restart-proof-provider",
        adapterVersion: "1",
        providerPayload: {
          cursor: "checkpoint-0",
          providerSession: "provider-session-a",
        },
      },
      resumedToolResults: 1,
      persistedToolResults: 1,
      turnIndexes: [0, 1],
      firstTurnToolSummary: [
        { tool: "write", argsHash: "hash-1", resultStatus: "ok", durationMs: 3 },
      ],
      finalProviderState: {
        adapterName: "restart-proof-provider",
        adapterVersion: "1",
        providerPayload: {
          cursor: "checkpoint-1",
          providerSession: "provider-session-a",
        },
      },
      sideEffectCount: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(recovered.trackedSessionAfterTerminal).toBeUndefined();
  });

  it("detects a replay-from-zero mutation through the committing dispatcher", () => {
    const opId = "op_process_restart_mutation";
    expect(run("persist", opId).status).toBe(0);

    const mutated = run("resume", opId, "replay-from-zero");
    expect(mutated.status).not.toBe(0);
    expect(mutated.stderr).toContain("duplicate committing side effect detected: count=2");
  });

  it.each([
    ["wrong-model", "durable model identity mismatch: mutated-model"],
    ["wrong-runtime", "durable runtime identity mismatch"],
  ])("rejects an independent %s mutation before continuation", (mutation, expectedError) => {
    const opId = `op_process_restart_${mutation}`;
    expect(run("persist", opId).status).toBe(0);

    const mutated = run("resume", opId, mutation);
    expect(mutated.status).not.toBe(0);
    expect(mutated.stderr).toContain(expectedError);
  });
});
