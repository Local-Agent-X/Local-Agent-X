import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { Op } from "../ops/types.js";
import type { ProcessExecutionClaim } from "./process-execution-claim.js";

const priorDataDir = process.env.LAX_DATA_DIR;
const priorAuditKey = process.env.LAX_AUDIT_KEY;
const dataDir = mkdtempSync(join(tmpdir(), "lax-process-relay-"));
process.env.LAX_DATA_DIR = dataDir;
process.env.LAX_AUDIT_KEY = "process-relay-test-key";

const { tryWithOpLock, writeOp } = await import("../ops/op-store.js");
const {
  claimProcessExecution,
  removeProcessExecutionClaim,
} = await import("./process-execution-claim.js");
const {
  createRelayGeneration,
  createRelayRecord,
  verifyRelayGeneration,
  verifyRelayRecord,
} = await import("./process-relay-contract.js");
const {
  acknowledgeProcessRelayTarget,
  appendProcessRelayRecord,
  cleanupCompletedProcessRelay,
  initializeProcessRelayJournal,
  readProcessRelayGenerations,
} = await import("./process-relay-journal.js");
const { reconcileProcessRelay } = await import("./process-relay-reconcile.js");

afterAll(() => {
  if (priorDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = priorDataDir;
  if (priorAuditKey === undefined) delete process.env.LAX_AUDIT_KEY;
  else process.env.LAX_AUDIT_KEY = priorAuditKey;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("durable process relay", () => {
  it("seals strict generation, payload, chain, and delivery identities", () => {
    const { claim } = fixture("contract");
    const sealed = createRelayGeneration(claim, "session-contract", "2026-07-21T00:00:00.000Z");
    expect(verifyRelayGeneration(sealed).generation.generationId).toHaveLength(64);
    const event = canonicalEvent(claim.opId, 0);
    const first = createRelayRecord(sealed.generation, 1, "canonical-event", event, sealed.mac);
    expect(first.deliveryId).toBe(`${sealed.generation.generationId}:1`);
    expect(first.targets).toEqual(["canonical-core", "session-observer", "browser-render"]);
    expect(createRelayRecord(sealed.generation, 2, "stream-chunk", { delta: "x" }, first.mac).targets)
      .toEqual(["canonical-core"]);
    expect(verifyRelayRecord(first, sealed.generation, 1, sealed.mac)).toEqual(first);
    expect(() => verifyRelayRecord(first, sealed.generation, 2, sealed.mac)).toThrow("non-contiguous");
    const replacement = createRelayGeneration({ ...claim, token: "replacement" },
      "session-contract", "2026-07-21T00:00:01.000Z");
    expect(() => verifyRelayRecord(first, replacement.generation, 1, replacement.mac))
      .toThrow("non-contiguous");
    expect(() => verifyRelayRecord({ ...first, payload: { ...event, type: "invented" } },
      sealed.generation, 1, sealed.mac)).toThrow("integrity");
    expect(() => createRelayRecord(sealed.generation, 2, "session-event",
      { type: "not-a-server-event" }, first.mac)).toThrow("unsupported");
  });

  it("flushes a record before returning its notice and rejects a tampered restart tail", () => {
    const { claim, sessionId } = fixture("durable");
    initializeProcessRelayJournal(claim, sessionId);
    const notice = appendProcessRelayRecord(claim, sessionId, "stream-chunk", { delta: "hello" });
    const path = relayFiles(claim.opId).find(item => item.endsWith(".jsonl")) as string;
    const persisted = readFileSync(path, "utf8");
    expect(persisted).toContain(`\"cursor\":${notice.cursor}`);
    expect(persisted.endsWith("\n")).toBe(true);
    expect(readProcessRelayGenerations(claim.opId)[0].records).toHaveLength(1);
    writeFileSync(path, persisted.replace("hello", "tampered"), "utf8");
    expect(() => readProcessRelayGenerations(claim.opId)).toThrow("integrity");
  });

  it("repairs only authenticated crash artifacts and discards an unsigned partial tail", () => {
    const empty = fixture("header-ack-repair");
    initializeProcessRelayJournal(empty.claim, empty.sessionId);
    const emptyAck = relayFiles(empty.opId).find(item => item.endsWith(".ack.json")) as string;
    rmSync(emptyAck);
    expect(readProcessRelayGenerations(empty.opId)[0].records).toEqual([]);
    expect(existsSync(emptyAck)).toBe(true);

    const partial = fixture("partial-tail-repair");
    initializeProcessRelayJournal(partial.claim, partial.sessionId);
    appendProcessRelayRecord(partial.claim, partial.sessionId, "stream-chunk", { delta: "safe" });
    const journal = relayFiles(partial.opId).find(item => item.endsWith(".jsonl")) as string;
    const complete = readFileSync(journal, "utf8");
    writeFileSync(journal, `${complete}{\"cursor\":`, "utf8");
    const tmp = `${journal}.999.${"a".repeat(8)}.tmp`;
    writeFileSync(tmp, "crash", "utf8");
    expect(readProcessRelayGenerations(partial.opId)[0].records).toHaveLength(1);
    expect(readFileSync(journal, "utf8")).toBe(complete);
    expect(existsSync(tmp)).toBe(false);
  });

  it("persists partial acknowledgements and retries a throwing sink in order", () => {
    const { claim, sessionId } = fixture("ack-retry");
    initializeProcessRelayJournal(claim, sessionId);
    appendProcessRelayRecord(claim, sessionId, "canonical-event", canonicalEvent(claim.opId, 0));
    appendProcessRelayRecord(claim, sessionId, "stream-chunk", { delta: "second" });
    const seen: string[] = [];
    expect(() => reconcileProcessRelay(claim.opId, (_state, record, target) => {
      seen.push(`${record.cursor}:${target}`);
      if (target === "browser-render") throw new Error("sink offline");
      return true;
    })).toThrow("sink offline");
    expect(seen).toEqual([
      "1:canonical-core", "2:canonical-core",
      "1:session-observer",
      "1:browser-render",
    ]);
    const restarted = readProcessRelayGenerations(claim.opId)[0];
    expect([...restarted.acknowledgements.get(1) ?? []]).toEqual(["canonical-core", "session-observer"]);
    const retried: string[] = [];
    reconcileProcessRelay(claim.opId, (_state, record, target) => {
      retried.push(`${record.cursor}:${target}`);
      return true;
    });
    expect(retried).toEqual(["1:browser-render"]);
  });

  it("merges acknowledgements written from independent stale snapshots", () => {
    const { claim, sessionId } = fixture("stale-ack-union");
    initializeProcessRelayJournal(claim, sessionId);
    appendProcessRelayRecord(claim, sessionId, "canonical-event", canonicalEvent(claim.opId, 0));
    const left = readProcessRelayGenerations(claim.opId)[0];
    const right = readProcessRelayGenerations(claim.opId)[0];
    acknowledgeProcessRelayTarget(left, 1, "canonical-core");
    acknowledgeProcessRelayTarget(right, 1, "browser-render");
    expect([...readProcessRelayGenerations(claim.opId)[0].acknowledgements.get(1) ?? []].sort())
      .toEqual(["browser-render", "canonical-core"]);
  });

  it("serializes overlapping reconciliation and keeps browser work pending", () => {
    const { claim, sessionId } = fixture("overlap");
    initializeProcessRelayJournal(claim, sessionId);
    appendProcessRelayRecord(claim, sessionId, "canonical-event", canonicalEvent(claim.opId, 0));
    let nested = -1;
    let canonicalProjectionCount = 0;
    let nestedLockAcquired = false;
    const applied = reconcileProcessRelay(claim.opId, (_state, _record, target) => {
      nested = reconcileProcessRelay(claim.opId, () => true);
      const lock = tryWithOpLock(claim.opId, () => true);
      nestedLockAcquired = lock.acquired && lock.value;
      if (target === "canonical-core") canonicalProjectionCount++;
      return target === "canonical-core";
    });
    expect(applied).toBe(1);
    expect(nested).toBe(0);
    expect(nestedLockAcquired).toBe(true);
    expect(canonicalProjectionCount).toBe(1);
    const state = readProcessRelayGenerations(claim.opId)[0];
    expect([...state.acknowledgements.get(1) ?? []]).toEqual(["canonical-core"]);
    expect(cleanupCompletedProcessRelay(claim.opId)).toBe(false);
  });

  it("serializes independent process reconcilers so canonical projection runs once", async () => {
    const { claim, sessionId } = fixture("cross-process-reconcile");
    initializeProcessRelayJournal(claim, sessionId);
    appendProcessRelayRecord(claim, sessionId, "canonical-event", canonicalEvent(claim.opId, 0));
    const marker = join(dataDir, `${claim.opId}.projections`);
    const script = join(dataDir, `${claim.opId}.mjs`);
    writeFileSync(script, `
import { appendFileSync } from "node:fs";
import { reconcileProcessRelay } from ${JSON.stringify(new URL("./process-relay-reconcile.ts", import.meta.url).href)};
const wait = new Int32Array(new SharedArrayBuffer(4));
reconcileProcessRelay(process.argv[2], (_state, _record, target) => {
  if (target !== "canonical-core") return false;
  appendFileSync(process.argv[3], "core\\n");
  Atomics.wait(wait, 0, 0, 120);
  return true;
});
process.exit(0);
`, "utf8");
    const loader = join(process.cwd(), "..", "..", "node_modules", "tsx", "dist", "loader.mjs");
    const args = ["--import", pathToFileURL(loader).href, script, claim.opId, marker];
    const env = { ...process.env, LAX_DATA_DIR: dataDir, LAX_AUDIT_KEY: "process-relay-test-key" };
    const results = await Promise.all([
      childExit(spawn(process.execPath, args, { env, stdio: "pipe" })),
      childExit(spawn(process.execPath, args, { env, stdio: "pipe" })),
    ]);
    expect(results).toEqual([0, 0]);
    expect(readFileSync(marker, "utf8").trim().split("\n")).toEqual(["core"]);
    expect([...readProcessRelayGenerations(claim.opId)[0].acknowledgements.get(1) ?? []])
      .toEqual(["canonical-core"]);
  });

  it("replays old generations before replacements and cleans up only fully acknowledged tails", () => {
    const first = fixture("generations", 1);
    initializeProcessRelayJournal(first.claim, first.sessionId);
    appendProcessRelayRecord(first.claim, first.sessionId, "stream-chunk", { delta: "old" });
    expect(removeProcessExecutionClaim(first.claim)).toBe(true);
    const second = fixture("generations", 2, first.opId);
    initializeProcessRelayJournal(second.claim, second.sessionId);
    appendProcessRelayRecord(second.claim, second.sessionId, "stream-chunk", { delta: "new" });
    expect(readProcessRelayGenerations(first.opId).map(state => state.sealedGeneration.generation.placementRevision))
      .toEqual([1, 2]);
    const delivery: string[] = [];
    reconcileProcessRelay(first.opId, (state, record) => {
      delivery.push(`${state.sealedGeneration.generation.placementRevision}:${record.cursor}`);
      return true;
    });
    expect(delivery).toEqual(["1:1", "2:1"]);
    expect(cleanupCompletedProcessRelay(first.opId)).toBe(false);
    expect(removeProcessExecutionClaim(second.claim)).toBe(true);
    expect(cleanupCompletedProcessRelay(first.opId)).toBe(true);
    expect(relayFiles(first.opId)).toEqual([]);
  });
});

function fixture(label: string, revision = 1, existingOpId?: string): {
  opId: string; sessionId: string; claim: ProcessExecutionClaim;
} {
  const opId = existingOpId ?? `op-relay-${label}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `session-${label}`;
  const now = new Date().toISOString();
  const op = {
    id: opId,
    type: "delegated_task",
    task: label,
    model: "test-model",
    lane: "background",
    retryPolicy: { maxRecoveryAttempts: 1, backoffMs: [0] },
    ownerId: "test",
    visibility: "private",
    status: "pending",
    createdAt: now,
    updatedAt: now,
    attemptCount: 0,
    canonical: {
      state: "running",
      sessionId,
      executionPlacement: {
        schemaVersion: 1,
        backendId: "local-process",
        targetId: "canonical-worker-process-v1",
        disposition: "ready",
        wakeToken: null,
        wakeRequestedAt: null,
        revision,
      },
    },
  } as unknown as Op;
  writeOp(op);
  const claim: ProcessExecutionClaim = {
    schemaVersion: 1,
    opId,
    backendId: "local-process",
    targetId: "canonical-worker-process-v1",
    placementRevision: revision,
    token: `token-${revision}`,
    pid: process.pid,
    processStartedAt: now,
    heartbeatAt: now,
  };
  expect(claimProcessExecution(claim)).toBe(true);
  return { opId, sessionId, claim };
}

function canonicalEvent(opId: string, seq: number) {
  return {
    opId,
    seq,
    type: "state_changed" as const,
    ts: new Date().toISOString(),
    body: { from: "running", to: "succeeded", reason: "test" },
  };
}

function relayFiles(opId: string): string[] {
  const directory = join(dataDir, "operations", opId, "process-relay");
  try { return readdirSync(directory).map(name => join(directory, name)); }
  catch { return []; }
}

function childExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", chunk => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve(code) : reject(new Error(stderr || `child exited ${code}`)));
  });
}
