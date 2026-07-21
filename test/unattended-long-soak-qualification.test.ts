import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const restartFixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "canonical-loop-restart-worker.ts",
);
const effectFixture = resolve("test/fixtures/side-effect-crash-worker.ts");

let dataDir: string;
let ledger: string;
let port: number;

function runRestart(action: "persist" | "resume", opId: string, mutation = "") {
  return spawnSync(process.execPath, [
    "--import=tsx",
    restartFixture,
    action,
    opId,
    ledger,
    mutation,
    String(port),
  ], {
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

function runEffect(opId: string, crashPhase = "") {
  return spawnSync(process.execPath, [
    "--import=tsx",
    effectFixture,
    "dispatch",
    ledger,
    opId,
    `call-${opId}`,
    "non-idempotent",
    crashPhase,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LAX_DATA_DIR: dataDir,
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

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function jsonLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line) as T);
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "lax-u6-qualification-"));
  ledger = join(dataDir, "external-effects.jsonl");
  port = 16_000 + Math.floor(Math.random() * 2_000);
});

afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

describe("unattended long-duration qualification", () => {
  it("resumes productive work whose persisted production start is over 150 minutes old", () => {
    const opId = "op_u6_aged_restart";
    const processA = runRestart("persist", opId, "hard-exit");
    expect(processA.status, processA.stderr).toBe(86);

    const opDir = join(dataDir, "operations", opId);
    const operationPath = join(opDir, "operation.json");
    const agedStartedAt = new Date(Date.now() - 151 * 60_000).toISOString();
    const interrupted = readJson<Record<string, unknown>>(operationPath);
    interrupted.startedAt = agedStartedAt;
    writeFileSync(operationPath, JSON.stringify(interrupted, null, 2));

    expect(existsSync(join(opDir, "op-turns", "0.json"))).toBe(true);
    const processB = runRestart("resume", opId);
    expect(processB.status, processB.stderr).toBe(0);

    const result = childResult<{
      state: string;
      attemptCount: number;
      turnIndexes: number[];
      persistedToolResults: number;
      sideEffectCount: number;
    }>(processB.stdout);
    expect(result).toMatchObject({
      state: "succeeded",
      attemptCount: 1,
      turnIndexes: [0, 1],
      persistedToolResults: 1,
      sideEffectCount: 1,
    });

    const completed = readJson<{
      startedAt?: string;
      canonical?: { state?: string; currentTurnIdx?: number; currentCheckpointId?: string };
    }>(operationPath);
    expect(completed.startedAt).toBe(agedStartedAt);
    expect(Date.now() - Date.parse(completed.startedAt!)).toBeGreaterThanOrEqual(150 * 60_000);
    expect(completed.canonical).toMatchObject({
      state: "succeeded",
      currentTurnIdx: 1,
      currentCheckpointId: `${opId}#1`,
    });
    expect(existsSync(join(opDir, "op-turns", "0.json"))).toBe(true);
    expect(existsSync(join(opDir, "op-turns", "1.json"))).toBe(true);

    const events = jsonLines<{ type: string; seq: number }>(join(opDir, "canonical-events.jsonl"));
    expect(events.map(event => event.seq)).toEqual(events.map((_, index) => index));
    expect(events.filter(event => event.type === "turn_committed")).toHaveLength(2);
    expect(events.some(event => event.type === "lease_lost")).toBe(true);
    expect(events.some(event => event.type === "state_changed")).toBe(true);
  });

  it("does not replay an ambiguous non-idempotent effect after a hard process death", () => {
    const opId = "op_u6_irreversible";
    const crashed = runEffect(opId, "effect_returned");
    expect(crashed.status, crashed.stderr).toBe(86);
    expect(jsonLines<{ opId: string }>(ledger)).toEqual([{ opId }]);

    const resumed = runEffect(opId);
    expect(resumed.status, resumed.stderr).toBe(0);
    const result = childResult<{ content: string; isError?: boolean }>(resumed.stdout);
    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("reconciliation_required");
    expect(jsonLines<{ opId: string }>(ledger)).toEqual([{ opId }]);
  });
});
