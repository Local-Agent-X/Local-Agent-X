/**
 * R2 item 14: real process termination at side-effect boundaries.
 *
 * Each first run exits abruptly from a durable journal hook. A new Node
 * process then reconstructs the runtime against the same operation store.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const fixture = resolve("test/fixtures/side-effect-crash-worker.ts");
let root: string;
let ledger: string;

function run(
  opId: string,
  phase = "",
  effectClass: "keyed-mutation" | "non-idempotent" = "keyed-mutation",
) {
  return spawnSync(process.execPath, [
    "--import=tsx", fixture, "dispatch", ledger, opId, `call-${opId}`, effectClass, phase,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, LAX_DATA_DIR: root, LAX_DISABLE_OS_KEYCHAIN: "1" },
    encoding: "utf-8",
    timeout: 10_000,
  });
}

function runAsync(
  opId: string,
  phase = "",
  effectClass: "keyed-mutation" | "non-idempotent" = "keyed-mutation",
): Promise<number | null> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [
      "--import=tsx", fixture, "dispatch", ledger, opId, `call-${opId}`, effectClass, phase,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, LAX_DATA_DIR: root, LAX_DISABLE_OS_KEYCHAIN: "1" },
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
}

function ledgerRows(): Array<{ opId: string; key?: string }> {
  try {
    return readFileSync(ledger, "utf-8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

function childResult<T>(stdout: string): T {
  const marker = stdout.lastIndexOf("@@RESULT@@");
  if (marker < 0) throw new Error(`child result marker missing: ${stdout}`);
  return JSON.parse(stdout.slice(marker + "@@RESULT@@".length)) as T;
}

function seedRecoverableOp(opId: string): void {
  const dir = join(root, "operations", opId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "operation.json"), JSON.stringify({
    id: opId,
    type: "mission",
    task: `resume ${opId}`,
    lane: "background",
    status: "running",
    visibility: "private",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [0] },
    canonical: { flagValue: true, state: "running", leaseOwner: null, leaseExpiresAt: null },
  }, null, 2));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lax-side-effect-crash-"));
  ledger = join(root, "external-ledger.jsonl");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("persisted side-effect journal crash/restart/resume", () => {
  it("executes one non-idempotent effect across concurrent runtimes", async () => {
    expect(await Promise.all([
      runAsync("same-operation", "", "non-idempotent"),
      runAsync("same-operation", "", "non-idempotent"),
    ])).toEqual([0, 0]);
    expect(ledgerRows().filter(row => row.opId === "same-operation")).toHaveLength(1);
  });

  it("runs once when the process dies after prepare but before the effect", () => {
    expect(run("before", "prepared").status).toBe(86);
    expect(ledgerRows()).toHaveLength(0);

    const resumed = run("before");
    expect(resumed.status).toBe(0);
    expect(childResult<{ content: string }>(resumed.stdout).content).toContain("receipt:before");
    expect(ledgerRows().filter(row => row.opId === "before")).toHaveLength(1);
  });

  it("uses the pinned external key after effect-before-result death", () => {
    expect(run("after-effect", "effect_returned").status).toBe(86);
    expect(ledgerRows().filter(row => row.opId === "after-effect")).toHaveLength(1);

    const resumed = run("after-effect");
    expect(resumed.status).toBe(0);
    expect(childResult<{ content: string }>(resumed.stdout).content).toContain("receipt:after-effect");
    expect(ledgerRows().filter(row => row.opId === "after-effect")).toHaveLength(1);
  });

  it("returns the recorded result after result persistence but before turn commit", () => {
    expect(run("after-result", "completed").status).toBe(86);
    expect(ledgerRows().filter(row => row.opId === "after-result")).toHaveLength(1);

    const resumed = run("after-result");
    expect(resumed.status).toBe(0);
    expect(childResult<{ content: string }>(resumed.stdout).content).toContain("receipt:after-result");
    expect(ledgerRows().filter(row => row.opId === "after-result")).toHaveLength(1);
  });

  it("requires explicit reconciliation for an ambiguous non-idempotent outcome", () => {
    expect(run("ambiguous", "effect_returned", "non-idempotent").status).toBe(86);
    expect(ledgerRows().filter(row => row.opId === "ambiguous")).toHaveLength(1);

    const resumed = run("ambiguous", "", "non-idempotent");
    expect(resumed.status).toBe(0);
    const result = childResult<{ content: string; isError?: boolean }>(resumed.stdout);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("reconciliation_required");
    expect(ledgerRows().filter(row => row.opId === "ambiguous")).toHaveLength(1);
  });

  it("preserves two concurrent operation journals through the restart sweep", async () => {
    expect(await Promise.all([
      runAsync("concurrent-a", "effect_returned"),
      runAsync("concurrent-b", "effect_returned"),
    ])).toEqual([86, 86]);
    seedRecoverableOp("concurrent-a");
    seedRecoverableOp("concurrent-b");

    const swept = spawnSync(process.execPath, ["--import=tsx", fixture, "sweep", ledger], {
      cwd: process.cwd(),
      env: { ...process.env, LAX_DATA_DIR: root, LAX_DISABLE_OS_KEYCHAIN: "1" },
      encoding: "utf-8",
      timeout: 10_000,
    });
    expect(swept.status).toBe(0);
    const outcomes = childResult<Array<{ opId: string; outcome: { kind: string } }>>(swept.stdout);
    expect(outcomes.filter(row => row.opId.startsWith("concurrent-")).map(row => row.outcome.kind).sort())
      .toEqual(["recovered", "recovered"]);

    expect(await Promise.all([runAsync("concurrent-a"), runAsync("concurrent-b")])).toEqual([0, 0]);
    expect(ledgerRows().filter(row => row.opId === "concurrent-a")).toHaveLength(1);
    expect(ledgerRows().filter(row => row.opId === "concurrent-b")).toHaveLength(1);
  });
});
