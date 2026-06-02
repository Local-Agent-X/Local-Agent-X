/**
 * Wait for a canonical op to reach a terminal state and return an OpResult.
 *
 * Resolution order (matches the legacy awaitOpResult contract):
 *   1. Op already terminal on disk → synthesize result immediately.
 *   2. Op active → subscribe to canonical events, resolve on
 *      state_changed → succeeded|failed|cancelled.
 *   3. Op not found → null.
 *   4. Timeout → null (the op keeps running).
 */
import type { OpResult } from "../ops/types.js";
import { readOp } from "../ops/op-store.js";
import { subscribeOpEvents } from "./control-api.js";
import type { CanonicalEvent, StateChangedBody } from "./types.js";

function terminalToResultStatus(to: string): OpResult["status"] {
  switch (to) {
    case "succeeded": return "completed";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "paused": return "paused";
    default: return "failed";
  }
}

function synthesizeFromDisk(opId: string): OpResult | null {
  const op = readOp(opId);
  if (!op) return null;
  const state = op.canonical?.state;
  if (state === "succeeded" || state === "failed" || state === "cancelled") {
    return {
      opId,
      status: terminalToResultStatus(state),
      finalSummary: op.lastFailureReason || `op ${opId} ${terminalToResultStatus(state)}`,
      filesChanged: [],
      error: op.lastFailureReason
        ? { message: op.lastFailureReason, recoverable: false }
        : undefined,
    };
  }
  // Legacy op rows persisted before canonical-loop migration may carry
  // op.status without canonical.state. Treat their terminal status as the
  // result so callers get a coherent answer on historical ops.
  if (op.status === "completed" || op.status === "failed" || op.status === "cancelled") {
    return {
      opId,
      status: op.status,
      finalSummary: op.lastFailureReason || `op ${opId} ${op.status}`,
      filesChanged: [],
      error: op.lastFailureReason
        ? { message: op.lastFailureReason, recoverable: false }
        : undefined,
    };
  }
  return null;
}

export type AwaitRunningResult = { running: true } | { running: false; reason: string };

const POST_RUNNING_STATES: ReadonlySet<string> = new Set([
  "running",
  "paused",
  "cancelling",
  "cancelled",
  "succeeded",
  "failed",
]);

function checkRunningFromDisk(opId: string): AwaitRunningResult | "not_found" | null {
  const op = readOp(opId);
  if (!op) return "not_found";
  const state = op.canonical?.state;
  if (state && POST_RUNNING_STATES.has(state)) return { running: true };
  return null;
}

export function awaitOpRunning(opId: string, timeoutMs = 5000): Promise<AwaitRunningResult> {
  const fromDisk = checkRunningFromDisk(opId);
  if (fromDisk === "not_found") return Promise.resolve({ running: false, reason: "op not found" });
  if (fromDisk) return Promise.resolve(fromDisk);

  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (result: AwaitRunningResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { off(); } catch { /* listener cleanup is best-effort */ }
      resolve(result);
    };

    const off = subscribeOpEvents(opId, (event: CanonicalEvent) => {
      if (event.type !== "state_changed") return;
      const body = event.body as StateChangedBody | undefined;
      const to = body?.to;
      if (!to) return;
      if (POST_RUNNING_STATES.has(to)) finish({ running: true });
    });

    // Race: state may have advanced between the disk read and the
    // subscription. Re-check after attaching.
    const racy = checkRunningFromDisk(opId);
    if (racy === "not_found") { finish({ running: false, reason: "op not found" }); return; }
    if (racy) { finish(racy); return; }

    timer = setTimeout(
      () => finish({ running: false, reason: `did not reach running within ${timeoutMs}ms` }),
      timeoutMs,
    );
    timer.unref?.();
  });
}

export function awaitCanonicalOp(opId: string, timeoutMs = 30 * 60 * 1000): Promise<OpResult | null> {
  const fromDisk = synthesizeFromDisk(opId);
  if (fromDisk) return Promise.resolve(fromDisk);

  const op = readOp(opId);
  if (!op) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (result: OpResult | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { off(); } catch { /* listener cleanup is best-effort */ }
      resolve(result);
    };

    const off = subscribeOpEvents(opId, (event: CanonicalEvent) => {
      if (event.type !== "state_changed") return;
      const body = event.body as StateChangedBody | undefined;
      const to = body?.to;
      if (!to) return;
      if (to !== "succeeded" && to !== "failed" && to !== "cancelled") return;
      const persisted = synthesizeFromDisk(opId);
      if (persisted) { finish(persisted); return; }
      finish({
        opId,
        status: terminalToResultStatus(to),
        finalSummary: `op ${opId} ${terminalToResultStatus(to)}`,
        filesChanged: [],
      });
    });

    // Race: terminal state may have been written between the disk read and
    // the subscription. Re-check after attaching.
    const racy = synthesizeFromDisk(opId);
    if (racy) { finish(racy); return; }

    timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
  });
}
