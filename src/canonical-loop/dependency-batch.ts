import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { opDir } from "../ops/event-log.js";
import { writeOpStrict } from "../ops/op-store.js";
import { resourceLocksForProvider } from "../ops/provider-matrix.js";
import type { Op } from "../ops/types.js";
import { randomId } from "../util/ids.js";
import { createLogger } from "../logger.js";
import { registerDependencyWaiter, validateDependencyBatch } from "./dependencies.js";
import { emit } from "./event-emitter.js";
import { resolveAdapterFactory, unregisterAdapterForOp } from "./runtime.js";
import { enqueueOp, pumpScheduler } from "./scheduler.js";
import type { CanonicalLane, StateChangedBody } from "./types.js";

interface DependencyBatchManifest {
  version: 1;
  batchId: string;
  opIds: string[];
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const logger = createLogger("canonical-loop.dependency-batch");

function batchDirectory(): string {
  return join(getLaxDir(), "operation-batches");
}

function manifestPath(batchId: string): string | null {
  return SAFE_ID.test(batchId) ? join(batchDirectory(), `${batchId}.json`) : null;
}

export function dependencyBatchAdmissionError(op: Op): string | null {
  if (!op.dependencyBatchId) return null;
  const path = manifestPath(op.dependencyBatchId);
  if (!path || !existsSync(path)) return "dependency batch was not committed";
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8")) as DependencyBatchManifest;
    if (manifest.version !== 1 || manifest.batchId !== op.dependencyBatchId
      || !Array.isArray(manifest.opIds) || !manifest.opIds.includes(op.id)) {
      return "dependency batch manifest does not authorize this operation";
    }
    return null;
  } catch {
    return "dependency batch manifest is corrupt";
  }
}

function initialize(op: Op, sessionId: string, batchId: string): void {
  op.dependencyBatchId = batchId;
  op.canonical ??= {};
  op.canonical.flagValue = true;
  op.canonical.state = "queued";
  if (sessionId) op.canonical.sessionId = sessionId;
  op.canonical.leaseOwner ??= null;
  op.canonical.leaseExpiresAt ??= null;
  op.canonical.pauseRequestedAt ??= null;
  op.canonical.cancelRequestedAt ??= null;
  op.canonical.redirectInstruction ??= null;
  op.canonical.redirectReceivedAt ??= null;
  op.canonical.currentTurnIdx ??= null;
  op.canonical.currentCheckpointId ??= null;
  op.resourceLocks = Array.from(new Set([
    ...(op.resourceLocks ?? []),
    ...resourceLocksForProvider(op.contextPack?.routing?.preferredProvider),
  ]));
}

function removeStaged(ops: readonly Op[]): void {
  for (const op of ops) {
    unregisterAdapterForOp(op.id);
    try { rmSync(opDir(op.id), { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function commitManifest(batchId: string, opIds: string[]): void {
  const directory = batchDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = manifestPath(batchId)!;
  const tmp = `${target}.${randomId("tmp")}`;
  try {
    const manifest: DependencyBatchManifest = { version: 1, batchId, opIds };
    writeFileSync(tmp, JSON.stringify(manifest), { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(tmp, target);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

/** Persist every DAG row before making any row scheduler-visible. */
export function admitDependencyBatch(ops: readonly Op[], sessionIds: readonly string[]): void {
  if (ops.length === 0 || ops.length !== sessionIds.length) {
    throw new Error("dependency batch admission requires one session id per operation");
  }
  validateDependencyBatch(ops);
  const batchId = randomId("batch");
  for (let index = 0; index < ops.length; index++) initialize(ops[index], sessionIds[index], batchId);
  try {
    for (const op of ops) {
      if (!resolveAdapterFactory(op)) throw new Error(`dependency batch adapter missing for ${op.id}`);
    }
    for (const op of ops) {
      if (!writeOpStrict(op)) throw new Error(`failed to persist dependency batch operation ${op.id}`);
    }
    commitManifest(batchId, ops.map(op => op.id));
  } catch (error) {
    removeStaged(ops);
    throw error;
  }

  const body: StateChangedBody = { from: null, to: "queued", reason: "submitted" };
  for (const op of ops) {
    try { registerDependencyWaiter(op); }
    catch (error) { logger.error(`committed batch waiter registration failed for ${op.id}: ${(error as Error).message}`); }
    try { emit(op.id, "state_changed", body); }
    catch (error) { logger.error(`committed batch event projection failed for ${op.id}: ${(error as Error).message}`); }
    try { enqueueOp(op.id, op.lane as CanonicalLane); }
    catch (error) { logger.error(`committed batch enqueue failed for ${op.id}: ${(error as Error).message}`); }
  }
  try { pumpScheduler(); }
  catch (error) { logger.error(`committed batch pump failed: ${(error as Error).message}`); }
}
