import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "lease-process-worker.ts");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makePersistedOp(): { dataDir: string; opId: string; gateDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "lax-lease-process-"));
  roots.push(dataDir);
  const opId = "op_cross_process_lease";
  const opDir = join(dataDir, "operations", opId);
  const gateDir = join(dataDir, "gate");
  mkdirSync(opDir, { recursive: true });
  mkdirSync(gateDir);
  writeFileSync(join(opDir, "operation.json"), JSON.stringify({
    id: opId,
    type: "freeform",
    task: "lease stress",
    contextPack: {},
    lane: "background",
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [] },
    ownerId: "test",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
    canonical: { flagValue: true, state: "queued" },
  }, null, 2));
  return { dataDir, opId, gateDir };
}

function childEnv(dataDir: string): NodeJS.ProcessEnv {
  return { ...process.env, LAX_DATA_DIR: dataDir, LAX_DISABLE_BACKGROUND_JOBS: "1" };
}

function collect(child: ChildProcessWithoutNullStreams): Promise<{ status: number | null; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); });
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  return new Promise(resolve => child.on("close", status => resolve({ status, stdout, stderr })));
}

function resultOf<T>(stdout: string): T {
  const marker = stdout.lastIndexOf("@@RESULT@@");
  if (marker < 0) throw new Error(`missing result marker: ${stdout}`);
  return JSON.parse(stdout.slice(marker + 10)) as T;
}

function runAction(dataDir: string, action: "heartbeat" | "release", opId: string, owner: string, generation: number) {
  return spawnSync(process.execPath, ["--import=tsx", fixture, action, opId, owner, String(generation), dataDir], {
    cwd: process.cwd(),
    env: childEnv(dataDir),
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
}

describe("lease acquisition across real processes", () => {
  it("elects exactly one fresh owner and fences old same-owner generations", async () => {
    const { dataDir, opId, gateDir } = makePersistedOp();
    const owners = Array.from({ length: 24 }, (_, index) => `worker-${index}`);
    const children = owners.map(owner => spawn(
      process.execPath,
      ["--import=tsx", fixture, "acquire", opId, owner, "0", gateDir],
      { cwd: process.cwd(), env: childEnv(dataDir), windowsHide: true },
    ));
    const completions = children.map(collect);

    const readyDeadline = Date.now() + 10_000;
    while (owners.some(owner => !exists(join(gateDir, `ready-${owner}`)))) {
      if (Date.now() >= readyDeadline) throw new Error("children did not reach lease gate");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    writeFileSync(join(gateDir, "go"), "go");
    const outputs = await Promise.all(completions);
    for (const output of outputs) expect(output.status, output.stderr).toBe(0);

    const results = outputs.map(output => resultOf<{
      ok: boolean;
      claim?: { owner: string; generation: number };
      reason?: string;
    }>(output.stdout));
    const winners = results.filter(result => result.ok);
    expect(winners).toHaveLength(1);
    expect(results.filter(result => result.reason === "held")).toHaveLength(owners.length - 1);

    const winner = winners[0].claim!;
    const staleGeneration = winner.generation - 1;
    for (const action of ["heartbeat", "release"] as const) {
      const stale = runAction(dataDir, action, opId, winner.owner, staleGeneration);
      expect(stale.status, stale.stderr).toBe(0);
      expect(resultOf(stale.stdout)).toEqual({ ok: false, reason: "claim_lost" });
    }
    const persisted = JSON.parse(readFileSync(join(dataDir, "operations", opId, "operation.json"), "utf8"));
    expect(persisted.canonical).toMatchObject({
      leaseOwner: winner.owner,
      leaseGeneration: winner.generation,
    });
  }, 30_000);
});

function exists(path: string): boolean {
  try { readFileSync(path); return true; } catch { return false; }
}
