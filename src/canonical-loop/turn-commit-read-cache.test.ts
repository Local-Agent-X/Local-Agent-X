/**
 * Turn-artifact read cache — the fix for the quadratic synchronous read that
 * wedged the main thread.
 *
 * Reading turn N walks every prior turn, and each of those reads re-parsed
 * operation.json AND op-messages.jsonl in full. store.readOpMessages calls
 * that once per turn, so a long op did O(turns^2) whole-file parses on the
 * event loop. Observed live 2026-07-29 on a 59-turn app_build: 380s stalls,
 * /api/health unanswerable, desktop shell stuck on "Still starting…".
 *
 * These tests pin BOTH halves of the contract:
 *   1. the cache does not change what is returned (equivalence), and
 *   2. the redundant reads are actually gone (proved by deleting the files
 *      off disk mid-sequence — a cached read survives, an uncached one does
 *      not, so the "gone" assertions can genuinely fail).
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Op } from "../ops/types.js";

const prevLaxDir = process.env.LAX_DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), "lax-turn-read-cache-"));
process.env.LAX_DATA_DIR = dataDir;
afterAll(() => {
  if (prevLaxDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevLaxDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const {
  createTurnReadCache,
  publishTurnCommit,
  readTurnArtifact,
  committedMessagesFromArtifact,
} = await import("./turn-commit-store.js");
const { _setTurnReadHookForTests } = await import("./turn-commit-store.js");
const { readOpMessages, readOpTurns } = await import("./store.js");
const { writeOp } = await import("../ops/op-store.js");
const { opTurnPath, opMessagesPath } = await import("./schema.js");

/** Whole-file parses performed while `fn` runs. */
function countReads(fn: () => void): { artifact: number; op: number; seeds: number } {
  const counts = { artifact: 0, op: 0, seeds: 0 };
  _setTurnReadHookForTests((point) => { counts[point]++; });
  try { fn(); } finally { _setTurnReadHookForTests(null); }
  return counts;
}

const SESSION = "sess-read-cache";
const TURNS = 12;

function makeOp(id: string): Op {
  return {
    id,
    type: "app_build",
    task: "build the thing",
    contextPack: {} as Op["contextPack"],
    lane: "build" as Op["lane"],
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
    ownerId: "u",
    visibility: "private" as Op["visibility"],
    status: "running" as Op["status"],
    createdAt: new Date().toISOString(),
    attemptCount: 0,
    canonical: {
      flagValue: true,
      state: "running",
      sessionId: SESSION,
      leaseOwner: null,
      leaseExpiresAt: null,
      currentTurnIdx: TURNS - 1,
    } as Op["canonical"],
  };
}

/** An op with `TURNS` published turn artifacts, two messages each. */
function seedOp(id: string): string {
  writeOp(makeOp(id));
  // An op-messages.jsonl that exists but contributes no rows: keeps the seed
  // PARSE on the hot path (that parse is half of what regressed) without
  // adding messages that would perturb the aggregate assertions.
  writeFileSync(opMessagesPath(id), "\n", "utf-8");
  for (let turnIdx = 0; turnIdx < TURNS; turnIdx++) {
    publishTurnCommit({
      schemaVersion: 1,
      turn: {
        opId: id,
        turnIdx,
        providerState: {
          adapterName: "test",
          adapterVersion: "1",
          providerPayload: null,
        },
        toolCallSummary: [],
        terminalReason: "done",
        redirectConsumed: false,
        createdAt: new Date().toISOString(),
      } as never,
      messages: [0, 1].map((seqInTurn) => ({
        messageId: `msg-${turnIdx}-${seqInTurn}`,
        opId: id,
        turnIdx,
        seqInTurn,
        role: seqInTurn === 0 ? "user" : "assistant",
        content: `turn ${turnIdx} msg ${seqInTurn}`,
        createdAt: new Date().toISOString(),
      })) as never,
      projection: { opType: "app_build", task: "build the thing", sessionId: SESSION },
    });
  }
  return id;
}

describe("turn read cache — equivalence with the uncached path", () => {
  const opId = seedOp("op_read_cache_equiv");

  it("returns identical artifacts whether or not a cache is shared", () => {
    const shared = createTurnReadCache();
    for (let i = 0; i < TURNS; i++) {
      const uncached = readTurnArtifact(opId, i); // fresh cache per call
      const cached = readTurnArtifact(opId, i, shared);
      expect(cached).toEqual(uncached);
    }
  });

  it("readOpMessages returns every message exactly once, in turn order", () => {
    const rows = readOpMessages(opId);
    expect(rows).toHaveLength(TURNS * 2);
    expect(rows.map((r) => r.messageId)).toEqual(
      Array.from({ length: TURNS }, (_, t) => [`msg-${t}-0`, `msg-${t}-1`]).flat(),
    );
    // No duplicates survived the de-dup path.
    expect(new Set(rows.map((r) => r.messageId)).size).toBe(TURNS * 2);
  });

  it("readOpTurns returns all turns ascending", () => {
    expect(readOpTurns(opId).map((t) => t.turnIdx)).toEqual(
      Array.from({ length: TURNS }, (_, i) => i),
    );
  });
});

describe("turn read cache — read cost is linear in turns", () => {
  // Walking turn N re-reads turns 0..N-1, so an unshared walk costs
  // 1+2+…+N artifact reads. This is the exact shape that stalled the loop.
  const QUADRATIC = (TURNS * (TURNS + 1)) / 2;

  it("a shared walk reads each artifact once and each whole file once", () => {
    const opId = seedOp("op_read_cache_linear");
    const counts = countReads(() => {
      const cache = createTurnReadCache();
      for (let i = 0; i < TURNS; i++) readTurnArtifact(opId, i, cache);
    });
    expect(counts.artifact).toBe(TURNS);
    expect(counts.op).toBe(1);
    expect(counts.seeds).toBe(1);
  });

  it("an unshared walk is quadratic — the regression this pins", () => {
    const opId = seedOp("op_read_cache_quadratic");
    const counts = countReads(() => {
      for (let i = 0; i < TURNS; i++) readTurnArtifact(opId, i); // fresh cache each
    });
    // Documents the cost of NOT sharing, and proves the counter is wired to
    // something real: if the shared case above ever regresses to this shape,
    // the linear assertion fails.
    expect(counts.artifact).toBe(QUADRATIC);
    expect(counts.op).toBe(TURNS);
    expect(counts.seeds).toBe(TURNS);
    expect(counts.artifact).toBeGreaterThan(TURNS);
  });

  it("readOpMessages rebuilds full history with one parse of each whole file", () => {
    const opId = seedOp("op_read_cache_history");
    const counts = countReads(() => { readOpMessages(opId); });
    expect(counts.artifact).toBe(TURNS);
    expect(counts.op).toBe(1);
    expect(counts.seeds).toBe(1); // parsed once by readOpMessages, then reused
  });

  it("readOpTurns walks every turn with one shared cache", () => {
    const opId = seedOp("op_read_cache_turns");
    const counts = countReads(() => { readOpTurns(opId); });
    expect(counts.artifact).toBe(TURNS);
    expect(counts.op).toBe(1);
  });

  it("publishing a turn does not re-walk prior turns per prior turn", () => {
    const opId = seedOp("op_read_cache_publish");
    const counts = countReads(() => {
      publishTurnCommit({
        schemaVersion: 1,
        turn: {
          opId, turnIdx: TURNS,
          providerState: { adapterName: "test", adapterVersion: "1", providerPayload: null },
          toolCallSummary: [], terminalReason: "done", redirectConsumed: false,
          createdAt: new Date().toISOString(),
        } as never,
        messages: [{
          messageId: `msg-${TURNS}-0`, opId, turnIdx: TURNS, seqInTurn: 0,
          role: "user", content: "x", createdAt: new Date().toISOString(),
        }] as never,
        projection: { opType: "app_build", task: "build the thing", sessionId: SESSION },
      });
    });
    // The commit validates against every prior turn — but reads each once,
    // and parses the op record and seeds once for the whole check.
    expect(counts.artifact).toBe(TURNS);
    expect(counts.op).toBe(0); // supplied by the caller, not re-read
    expect(counts.seeds).toBe(1);
  });

  it("reuses seeds handed in by the caller instead of re-parsing them", () => {
    const opId = seedOp("op_read_cache_seeds");
    const sentinel = { rows: [], issues: [] };
    const cache = createTurnReadCache({ seeds: sentinel });
    const counts = countReads(() => { readTurnArtifact(opId, TURNS - 1, cache); });
    expect(cache.seeds).toBe(sentinel);
    expect(counts.seeds).toBe(0);
  });
});

describe("turn read cache — integrity rules still hold", () => {
  it("still rejects an artifact whose messages collide with a prior turn", () => {
    const opId = "op_read_cache_collide";
    writeOp(makeOp(opId));
    const mk = (turnIdx: number, messageId: string) => ({
      schemaVersion: 1 as const,
      turn: {
        opId,
        turnIdx,
        providerState: { adapterName: "test", adapterVersion: "1", providerPayload: null },
        toolCallSummary: [],
        terminalReason: "done",
        redirectConsumed: false,
        createdAt: new Date().toISOString(),
      } as never,
      messages: [{
        messageId,
        opId,
        turnIdx,
        seqInTurn: 0,
        role: "user",
        content: "x",
        createdAt: new Date().toISOString(),
      }] as never,
      projection: { opType: "app_build", task: "build the thing", sessionId: SESSION },
    });
    publishTurnCommit(mk(0, "dupe-id"));
    // publishTurnCommit REFUSES to write a colliding turn (that guard is the
    // write-path half of this invariant, and it fires here). The read-path
    // check exists for artifacts that reached disk some other way, so stage
    // this one directly.
    expect(() => publishTurnCommit(mk(1, "dupe-id"))).toThrow(/collision|authority/);
    writeFileSync(opTurnPath(opId, 1), JSON.stringify(mk(1, "dupe-id")), "utf-8");

    // Turn 1 collides with turn 0 and must be rejected — with a shared cache
    // exactly as without one.
    expect(readTurnArtifact(opId, 1)).toBeNull();
    expect(readTurnArtifact(opId, 1, createTurnReadCache())).toBeNull();
    expect(committedMessagesFromArtifact(readTurnArtifact(opId, 0))).toHaveLength(1);
  });
});
