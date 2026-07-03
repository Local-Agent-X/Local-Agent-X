/**
 * OP-4 — the lost-registration fail-closed adapter and its discriminator.
 *
 * A recovered op that lost its in-memory per-op adapter must FAIL CLOSED
 * (finalize running->failed with a resubmit reason) instead of silently
 * running on the lane default with zero tools ("planning mode"). But that
 * fail-closed path must be reached ONLY on a genuine restart-recovery relaunch,
 * never on an in-process pause->resume of a lane-default rider — which also has
 * a committed op_turn on disk yet keeps its live registration.
 *
 * The discriminator is attemptCount (only recovery.ts increments it, on the
 * running->queued restart relaunch; in-process opResume never routes through
 * recovery.ts). This REPLACES the earlier "op committed a turn on disk" proxy,
 * which also fired for an in-process resume and wrongly killed a live op.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resetCanonicalRuntime,
  registerAdapterForOp,
  setDefaultAdapterForLane,
  resolveAdapterFactory,
  lostRegistrationAdapterFactory,
} from "../src/canonical-loop/runtime.js";
import { insertOpTurn } from "../src/canonical-loop/store.js";
import type { Adapter } from "../src/canonical-loop/adapter-contract.js";
import type { Op } from "../src/ops/types.js";

let seq = 0;
let prevDataDir: string | undefined;
let tmp: string;

function makeOp(over: Partial<Op>): Op {
  return {
    id: `op_op4_${seq++}`,
    type: "freeform",
    task: "t",
    lane: "build",
    attemptCount: 0,
    ...over,
  } as unknown as Op;
}

// A stand-in build-lane adapter; only its identity matters for these assertions.
function laneDefaultFactory(): Adapter {
  return {
    name: "build-lane-default",
    version: "1",
    async runTurn() {
      return {
        providerState: { adapterName: "build-lane-default", adapterVersion: "1", providerPayload: null },
        terminalReason: "done",
      };
    },
    async abort() {
      /* nothing in flight */
    },
  };
}

beforeEach(() => {
  prevDataDir = process.env.LAX_DATA_DIR;
  tmp = mkdtempSync(join(tmpdir(), "op4-"));
  process.env.LAX_DATA_DIR = tmp;
  resetCanonicalRuntime();
});
afterEach(() => {
  resetCanonicalRuntime();
  if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevDataDir;
  rmSync(tmp, { recursive: true, force: true });
});

describe("OP-4 — lost-registration discriminator (attemptCount, not disk turn)", () => {
  it("in-process resume (attemptCount 0) rides the LIVE lane default even WITH a committed op_turn on disk", () => {
    const op = makeOp({ lane: "build", attemptCount: 0 });
    // The exact shape the skeptic flagged: a committed op_turn exists (the old
    // proxy would read this as "registration lost"), but the process never
    // restarted, so attemptCount is still 0 and the registration is intact.
    insertOpTurn({
      opId: op.id,
      turnIdx: 0,
      providerState: { adapterName: "build-lane-default", adapterVersion: "1", providerPayload: null },
      toolCallSummary: [],
      terminalReason: null,
      redirectConsumed: false,
      createdAt: new Date().toISOString(),
    });
    setDefaultAdapterForLane("build", laneDefaultFactory);

    const resolved = resolveAdapterFactory(op);
    expect(resolved).toBe(laneDefaultFactory);
    expect(resolved).not.toBe(lostRegistrationAdapterFactory);
  });

  it("genuine restart-recovery (attemptCount > 0, no per-op reg) fails closed to the lost-registration adapter", () => {
    const op = makeOp({ lane: "build", attemptCount: 1 });
    setDefaultAdapterForLane("build", laneDefaultFactory); // lane default present...
    // ...but a recovered op lost its per-op registration, so it must fail
    // closed rather than run tool-less on the lane default ("planning mode").
    expect(resolveAdapterFactory(op)).toBe(lostRegistrationAdapterFactory);
  });

  it("a per-op registration always wins, even for a recovered op", () => {
    const op = makeOp({ lane: "build", attemptCount: 5 });
    const perOp = laneDefaultFactory;
    registerAdapterForOp(op.id, perOp);
    expect(resolveAdapterFactory(op)).toBe(perOp);
  });
});
