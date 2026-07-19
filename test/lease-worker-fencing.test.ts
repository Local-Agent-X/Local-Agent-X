import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  awaitIdle,
  canonicalLoopEntry,
  readCanonicalEvents,
  registerAdapterForOp,
  resetBus,
  resetCanonicalRuntime,
  resetLeaseConfig,
  resetScheduler,
  setLeaseConfig,
} from "../src/canonical-loop/index.js";
import { _setStrictOpWriteFailureForTest, newOpId, readOp } from "../src/ops/op-store.js";
import type { Adapter, TurnResult } from "../src/canonical-loop/adapter-contract.js";
import type { Op } from "../src/ops/types.js";

const opsBase = join(homedir(), ".lax", "operations");
let opId = "";

class AbortCompletesAdapter implements Adapter {
  readonly name = "abort-completes";
  readonly version = "0.0.1";
  abortCalls = 0;
  private finish: ((result: TurnResult) => void) | null = null;

  runTurn(): Promise<TurnResult> {
    return new Promise(resolve => { this.finish = resolve; });
  }

  async abort(): Promise<void> {
    this.abortCalls++;
    this.finish?.({
      providerState: { adapterName: this.name, adapterVersion: this.version, providerPayload: {} },
      terminalReason: undefined,
    });
  }
}

beforeEach(() => {
  process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "1";
  setLeaseConfig({ leaseDurationMs: 100, heartbeatIntervalMs: 25 });
  opId = newOpId("worker-fencing");
});

afterEach(async () => {
  await awaitIdle(3_000).catch(() => undefined);
  resetScheduler();
  resetCanonicalRuntime();
  resetBus();
  resetLeaseConfig();
  _setStrictOpWriteFailureForTest(null);
  rmSync(join(opsBase, opId), { recursive: true, force: true });
  delete process.env.LAX_CANONICAL_LOOP_INTERACTIVE;
});

describe("worker lease fencing", () => {
  it("retries a queued op after an acquire persistence failure", async () => {
    const injected = Object.assign(new Error("injected acquire failure"), { code: "EIO" });
    _setStrictOpWriteFailureForTest(injected, "before_rename");
    registerAdapterForOp(opId, () => ({
      name: "completes",
      version: "0.0.1",
      async runTurn() {
        return {
          providerState: { adapterName: "completes", adapterVersion: "0.0.1", providerPayload: {} },
          terminalReason: "done" as const,
        };
      },
      async abort() {},
    }));

    canonicalLoopEntry(makeOp(opId));
    await waitFor(() => readOp(opId)?.canonical?.state === "succeeded", 3_000);
    expect(readCanonicalEvents(opId).filter(event => event.type === "lease_acquired")).toHaveLength(1);
  });

  it("aborts before an expired contended claim can be taken by another process", async () => {
    const adapter = new AbortCompletesAdapter();
    registerAdapterForOp(opId, () => adapter);
    canonicalLoopEntry(makeOp(opId));
    await waitFor(() => readOp(opId)?.canonical?.state === "running");

    const lock = join(opsBase, opId, "operation.lock");
    writeFileSync(lock, "foreign-live-holder", { flag: "wx" });
    await waitFor(() => adapter.abortCalls > 0, 3_000);
    rmSync(lock, { force: true });

    const gate = join(opsBase, opId, "lease-child-gate");
    mkdirSync(gate);
    writeFileSync(join(gate, "go"), "go");
    const child = spawnSync(process.execPath, [
      "--import=tsx",
      join(process.cwd(), "test", "fixtures", "lease-process-worker.ts"),
      "acquire", opId, "replacement-process", "0", gate,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10_000, windowsHide: true });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain('"ok":true');
    expect(readOp(opId)?.canonical?.leaseOwner).toBe("replacement-process");
    expect(readCanonicalEvents(opId).filter(event => event.type === "turn_committed")).toHaveLength(0);
  }, 15_000);
});

function makeOp(id: string): Op {
  return {
    id,
    type: "freeform",
    task: "prove heartbeat fencing",
    contextPack: {},
    lane: "interactive",
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [] },
    ownerId: "test",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition not reached before timeout");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
