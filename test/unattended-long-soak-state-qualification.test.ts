import { describe, expect, it } from "vitest";

import {
  checkToolLoops,
  createLoopState,
  noteToolResults,
} from "../src/agent-guards/index.js";
import { RecoveryJanitor } from "../src/canonical-loop/recovery-janitor.js";
import { sweepStaleCanonicalOpsCooperatively } from "../src/canonical-loop/recovery.js";
import type { Op } from "../src/ops/types.js";

type Timer = ReturnType<typeof setTimeout>;

describe("unattended soak bounded state", () => {
  it("schedules 120 janitor cycles with one timer and no overlap", async () => {
    const pending: Array<() => void> = [];
    let sweeps = 0;
    const janitor = new RecoveryJanitor({
      intervalMs: 60_000,
      sweep: async () => { sweeps += 1; },
      setTimer: callback => {
        pending.push(callback);
        return { unref() {} } as unknown as Timer;
      },
      clearTimer: () => { pending.length = 0; },
    });
    janitor.start();
    for (let minute = 0; minute < 120; minute++) {
      expect(pending).toHaveLength(1);
      pending.shift()!();
      await new Promise(resolve => setImmediate(resolve));
    }
    expect(sweeps).toBe(120);
    expect(pending).toHaveLength(1);
    janitor.stop();
  });

  it("yields a large persisted-history scan and bounds progress-detector memory", async () => {
    const ids = Array.from({ length: 4_096 }, (_, index) => `historical-${index}`);
    let readsSinceYield = 0;
    let maxReadsBetweenYields = 0;
    let yields = 0;
    const outcomes = await sweepStaleCanonicalOpsCooperatively({
      listOpIds: () => ids,
      batchSize: 16,
      timeSliceMs: Number.MAX_SAFE_INTEGER,
      readCandidate: () => {
        readsSinceYield += 1;
        maxReadsBetweenYields = Math.max(maxReadsBetweenYields, readsSinceYield);
        return { canonical: { flagValue: false, state: "succeeded" } } as Op;
      },
      now: () => 0,
      yieldToEventLoop: async () => {
        yields += 1;
        readsSinceYield = 0;
      },
    });
    expect(outcomes).toEqual([]);
    expect(maxReadsBetweenYields).toBeLessThanOrEqual(16);
    expect(yields).toBe(255);

    const state = createLoopState();
    for (let index = 0; index < 5_000; index++) {
      const call = [{ name: "web_fetch", arguments: JSON.stringify({ page: index }) }];
      expect(checkToolLoops(call, state, { modelTier: "strong", deferWorkerPivot: true }).abort).toBe(false);
      const observation = noteToolResults(call, state, [{ content: `novel-${index}`, status: "ok" }], {
        modelTier: "strong",
        armWorkerPivot: true,
      });
      expect(observation.pendingPivot).toBeNull();
    }
    expect(state.seenResultSigs.size).toBeLessThanOrEqual(256);
    expect(state.seenSuccessfulMutationKeys.size).toBeLessThanOrEqual(256);
  });
});
