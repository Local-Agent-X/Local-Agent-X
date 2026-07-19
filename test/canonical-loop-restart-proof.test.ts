import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "canonical-loop-restart-worker.ts");
let dataDir: string;
let ledger: string;
let port: number;

function run(action: "persist" | "resume", opId: string, mutation = "") {
  return spawnSync(process.execPath, ["--import=tsx", fixture, action, opId, ledger, mutation, String(port)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LAX_DATA_DIR: dataDir,
      LAX_DISABLE_BACKGROUND_JOBS: "1",
      LAX_DISABLE_OS_KEYCHAIN: "1",
      OLLAMA_CLOUD_API_KEY: "restart-cloud-secret",
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
  port = 12_000 + Math.floor(Math.random() * 4_000);
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
      model: string;
      canonicalSessionId: string;
      trackedSessionDuringResume: string;
      trackedSessionAfterTerminal?: string;
      requestModels: string[];
      requestPaths: string[];
      dispatcherCalls: number;
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
        adapter: "provider-exact",
        provider: "local",
        credentialProvider: "local",
        authSource: "sentinel",
        model: "restart-proof-model",
        runtime: "openai-compat",
        target: { kind: "local-config" },
        sessionId: "session-across-restart",
        integrity: { scheme: "hmac-sha256-v1" },
      },
      model: "restart-proof-model",
      canonicalSessionId: "session-across-restart",
      requestModels: ["restart-proof-model"],
      requestPaths: ["/v1/chat/completions"],
      dispatcherCalls: 0,
      persistedToolResults: 1,
      turnIndexes: [0, 1],
      firstTurnToolSummary: [
        { tool: "write", argsHash: "hash-1", resultStatus: "ok", durationMs: 3 },
      ],
      sideEffectCount: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(recovered.trackedSessionAfterTerminal).toBeUndefined();
  });

  it("ignores provider/model settings changes and resumes the persisted local runtime", () => {
    const opId = "op_process_restart_settings_changed";
    expect(run("persist", opId).status).toBe(0);
    const resumed = run("resume", opId, "settings-changed");
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(childResult<{ model: string; requestModels: string[] }>(resumed.stdout)).toMatchObject({
      model: "restart-proof-model",
      requestModels: ["restart-proof-model"],
    });
  });

  it("rehydrates the exact cloud credential source for a cloud model selected under Local", () => {
    const opId = "op_process_restart_local_picker_cloud";
    expect(run("persist", opId, "cloud-runtime").status).toBe(0);
    const resumed = run("resume", opId, "settings-changed-cloud");
    expect(resumed.status, resumed.stderr).toBe(0);
    const recovered = childResult<{
      runtimeDescriptor: { provider: string; credentialProvider: string };
      requestModels: string[];
      authorizationHeaders: string[];
    }>(resumed.stdout);
    expect(recovered.runtimeDescriptor).toMatchObject({ provider: "local", credentialProvider: "ollama-cloud" });
    expect(recovered.requestModels).toEqual(["restart-proof-model"]);
    expect(recovered.authorizationHeaders).toEqual(["Bearer restart-cloud-secret"]);
  });

  it("detects a replay-from-zero mutation through the committing dispatcher", () => {
    const opId = "op_process_restart_mutation";
    expect(run("persist", opId).status).toBe(0);

    const mutated = run("resume", opId, "replay-from-zero");
    expect(mutated.status, `stdout=${mutated.stdout}\nstderr=${mutated.stderr}`).not.toBe(0);
    expect(mutated.stderr).toContain("duplicate committing side effect detected: count=2");
  });

  it.each([
    ["wrong-model", "restart recovery did not succeed: state=failed"],
    ["wrong-runtime", "restart recovery did not succeed: state=failed"],
    ["missing-model", "restart recovery did not succeed: state=failed"],
    ["missing-provider", "restart recovery did not succeed: state=failed"],
    ["wrong-provider", "restart recovery did not succeed: state=failed"],
    ["missing-runtime", "restart recovery did not succeed: state=failed"],
    ["missing-credential-provider", "restart recovery did not succeed: state=failed"],
    ["wrong-credential-provider", "restart recovery did not succeed: state=failed"],
  ])("rejects an independent %s mutation before continuation", (mutation, expectedError) => {
    const opId = `op_process_restart_${mutation}`;
    expect(run("persist", opId).status).toBe(0);

    const mutated = run("resume", opId, mutation);
    expect(mutated.status).not.toBe(0);
    expect(mutated.stderr).toContain(expectedError);
  });
});
