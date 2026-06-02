/**
 * Regression suite for persistOpKeepingSignals (src/canonical-loop/op-persist.ts).
 *
 * The contract: a loop-side persist must NOT clobber control-API signal
 * columns (pauseRequestedAt / cancelRequestedAt / redirectInstruction) that
 * already live on disk, even when the in-memory op carries different (or
 * null) values for them.
 *
 *   - pause/cancel/redirect on disk SURVIVE a persist whose op fields differ
 *   - clearRedirect=true actually drops the redirect columns
 *   - clearRedirect=false (default) preserves the redirect columns
 *
 * op-store resolves its on-disk base from LAX_DATA_DIR *at module load*, so we
 * set the env var to a fresh temp dir BEFORE dynamically importing the modules
 * under test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Op } from "../src/ops/types.js";
import type { RedirectInstruction } from "../src/canonical-loop/types.js";

let dataDir: string;
let persistOpKeepingSignals: typeof import("../src/canonical-loop/op-persist.js").persistOpKeepingSignals;
let readOp: typeof import("../src/ops/op-store.js").readOp;
let writeOp: typeof import("../src/ops/op-store.js").writeOp;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "op-persist-signals-"));
  process.env.LAX_DATA_DIR = dataDir;
  // Import AFTER env is set: op-store/event-log compute OPS_BASE at load time.
  ({ persistOpKeepingSignals } = await import("../src/canonical-loop/op-persist.js"));
  ({ readOp, writeOp } = await import("../src/ops/op-store.js"));
});

afterAll(() => {
  delete process.env.LAX_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

let counter = 0;
function freshOp(canonical?: Op["canonical"]): Op {
  return {
    id: `op_persist_signals_${counter++}`,
    type: "freeform",
    task: "regression fixture",
    contextPack: {
      task: { description: "x", successCriteria: [], constraints: [], notWhatToRedo: [] },
      context: { recentTurns: [], referencedFiles: [], memoryHits: [], agentsRules: "" },
      capabilities: {},
      budget: { maxIterations: 1, maxTokens: 1, maxWallTimeMs: 1, maxSelfEditCalls: 0 },
      routing: { lane: "interactive" },
      secrets: { allowed: [] },
    },
    lane: "interactive",
    retryPolicy: { maxRecoveryAttempts: 0, backoffMs: [] },
    ownerId: "owner",
    visibility: "private",
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    attemptCount: 0,
    canonical,
  };
}

const REDIRECT: RedirectInstruction = {
  instructionId: "instr-1",
  text: "go left instead",
  receivedAt: "2026-01-01T00:05:00.000Z",
};

describe("persistOpKeepingSignals — control-API signals survive loop writes", () => {
  beforeEach(() => {
    counter++; // extra spacing so ids never collide across re-runs
  });

  it("preserves on-disk pause/cancel/redirect when the in-memory op nulls them", () => {
    const op = freshOp();
    // Control API set the signals on disk.
    writeOp(freshAt(op.id, {
      pauseRequestedAt: "2026-01-01T00:01:00.000Z",
      cancelRequestedAt: "2026-01-01T00:02:00.000Z",
      redirectInstruction: REDIRECT,
      redirectReceivedAt: REDIRECT.receivedAt,
    }));

    // Worker-side persist with the signals null in memory.
    const inMemory = freshAt(op.id, {
      state: "running",
      pauseRequestedAt: null,
      cancelRequestedAt: null,
      redirectInstruction: null,
      redirectReceivedAt: null,
    });
    persistOpKeepingSignals(inMemory);

    const disk = readOp(op.id)!;
    expect(disk.canonical?.pauseRequestedAt).toBe("2026-01-01T00:01:00.000Z");
    expect(disk.canonical?.cancelRequestedAt).toBe("2026-01-01T00:02:00.000Z");
    expect(disk.canonical?.redirectInstruction).toEqual(REDIRECT);
    expect(disk.canonical?.redirectReceivedAt).toBe(REDIRECT.receivedAt);
    // The loop-owned column the persist DID intend to write is honored.
    expect(disk.canonical?.state).toBe("running");
  });

  it("preserves on-disk signals even when the in-memory op carries DIFFERENT signal values", () => {
    const op = freshOp();
    writeOp(freshAt(op.id, {
      pauseRequestedAt: "2026-01-01T00:01:00.000Z",
      cancelRequestedAt: "2026-01-01T00:02:00.000Z",
    }));

    const inMemory = freshAt(op.id, {
      pauseRequestedAt: "2099-12-31T00:00:00.000Z",
      cancelRequestedAt: "2099-12-31T00:00:00.000Z",
    });
    persistOpKeepingSignals(inMemory);

    const disk = readOp(op.id)!;
    // Disk values win — the loop is not the owner of these columns.
    expect(disk.canonical?.pauseRequestedAt).toBe("2026-01-01T00:01:00.000Z");
    expect(disk.canonical?.cancelRequestedAt).toBe("2026-01-01T00:02:00.000Z");
  });

  it("clearRedirect=false (default) preserves the on-disk redirect columns", () => {
    const op = freshOp();
    writeOp(freshAt(op.id, {
      redirectInstruction: REDIRECT,
      redirectReceivedAt: REDIRECT.receivedAt,
    }));

    const inMemory = freshAt(op.id, {
      redirectInstruction: null,
      redirectReceivedAt: null,
    });
    persistOpKeepingSignals(inMemory); // default opts

    const disk = readOp(op.id)!;
    expect(disk.canonical?.redirectInstruction).toEqual(REDIRECT);
    expect(disk.canonical?.redirectReceivedAt).toBe(REDIRECT.receivedAt);
  });

  it("clearRedirect=true drops the redirect columns but still keeps pause/cancel", () => {
    const op = freshOp();
    writeOp(freshAt(op.id, {
      pauseRequestedAt: "2026-01-01T00:01:00.000Z",
      cancelRequestedAt: "2026-01-01T00:02:00.000Z",
      redirectInstruction: REDIRECT,
      redirectReceivedAt: REDIRECT.receivedAt,
    }));

    // commitTurn applied the redirect and now clears it.
    const inMemory = freshAt(op.id, {
      redirectInstruction: null,
      redirectReceivedAt: null,
    });
    persistOpKeepingSignals(inMemory, { clearRedirect: true });

    const disk = readOp(op.id)!;
    expect(disk.canonical?.redirectInstruction).toBeNull();
    expect(disk.canonical?.redirectReceivedAt).toBeNull();
    // Pause/cancel are NOT redirect columns; they must still be preserved.
    expect(disk.canonical?.pauseRequestedAt).toBe("2026-01-01T00:01:00.000Z");
    expect(disk.canonical?.cancelRequestedAt).toBe("2026-01-01T00:02:00.000Z");
  });
});

/** Build an op with the same id but a specific canonical sub-object. */
function freshAt(id: string, canonical: Op["canonical"]): Op {
  const op = freshOp(canonical);
  op.id = id;
  return op;
}
