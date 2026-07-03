/**
 * CL-9 regression: canonical-event `seq` assignment.
 *
 * 1. CROSS-PROCESS CORRECTNESS (the critical one): two writers for ONE op that
 *    do NOT share process memory — the lease-holding worker AND control-api
 *    emitting cancel/redirect from a possibly-second server on the same
 *    ~/.lax — both append, and the resulting seq stream must be strictly
 *    monotonic with NO duplicates and NO gaps. Two independent processes are
 *    simulated with two distinct module instances of store.ts (distinct
 *    query strings ⇒ distinct module registries ⇒ distinct in-memory seq
 *    caches), contending on the one on-disk canonical-events.jsonl + op lock.
 *    This FAILS on a naive per-process in-memory counter: the second writer's
 *    counter is blind to the first writer's appends, so the two hand out the
 *    same seq (duplicate + gap).
 *
 * 2. HOT PATH (the friction being fixed): a warm single writer must NOT do a
 *    full-file readFileSync on every emit. We wrap node:fs.readFileSync with a
 *    counter and assert that, once the cache is warm and no foreign writer has
 *    appended, a burst of emits reads the canonical log ZERO times.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonicalEvent } from "./types.js";

// Count full-file reads of the canonical event log without disturbing any
// other fs usage (op-store/event-log statSync/appendFileSync stay real).
const h = vi.hoisted(() => ({ canonReads: 0 }));
vi.mock("node:fs", async (importActual) => {
  const actual = await importActual<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: ((p: unknown, ...rest: unknown[]) => {
      if (typeof p === "string" && p.includes("canonical-events")) h.canonReads++;
      return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof actual.readFileSync,
  };
});

// opDir/event-log capture the ops base at module load, so the data-dir
// override must be in place before the dynamic imports below.
const dataDir = mkdtempSync(join(tmpdir(), "lax-store-seq-"));
process.env.LAX_DATA_DIR = dataDir;

// Two DISTINCT module instances = two simulated processes. Each has its own
// module-level seq cache and its own withOpLock heldLocks set, but both write
// the same on-disk log and contend on the same on-disk lockfile — exactly the
// cross-process condition CL-9 must survive. The query string forces Vite to
// hand back a separate module registry per specifier; the specifiers are
// variables (not literals) so tsc does not try to resolve the `?proc=` suffix.
const workerSpec = "./store.ts?proc=worker";
const controlApiSpec = "./store.ts?proc=control-api";
const worker = await import(workerSpec) as typeof import("./store.js");
const controlApi = await import(controlApiSpec) as typeof import("./store.js");

afterAll(() => {
  delete process.env.LAX_DATA_DIR;
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  worker._resetSeqCache();
  controlApi._resetSeqCache();
  h.canonReads = 0;
});

describe("appendCanonicalEvent — cross-process seq authority (CL-9)", () => {
  it("keeps seq strictly monotonic with no dupes/gaps across two writers", () => {
    const opId = "op_two_writer";

    // Interleave the two processes: worker drives turns, control-api lands a
    // cancel/redirect in between — the exact OP-9 concurrency shape.
    worker.appendCanonicalEvent(opId, "turn_started");           // seq 0
    worker.appendCanonicalEvent(opId, "message_appended");      // seq 1
    controlApi.appendCanonicalEvent(opId, "cancel_requested");   // seq 2 (2nd proc)
    worker.appendCanonicalEvent(opId, "turn_committed");         // seq 3
    controlApi.appendCanonicalEvent(opId, "redirect_received");  // seq 4 (2nd proc)
    worker.appendCanonicalEvent(opId, "turn_started");           // seq 5
    controlApi.appendCanonicalEvent(opId, "cancel_requested");   // seq 6 (2nd proc)
    worker.appendCanonicalEvent(opId, "turn_committed");         // seq 7

    const seqs = worker.readCanonicalEvents(opId).map((e: CanonicalEvent) => e.seq);
    expect(seqs).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    // Explicit invariants (independent of the exact expected array):
    const unique = new Set(seqs);
    expect(unique.size).toBe(seqs.length);                       // no duplicates
    for (let i = 0; i < seqs.length; i++) expect(seqs[i]).toBe(i); // monotonic, no gaps
  });

  it("re-seeds a fresh process from disk before it hands out a seq", () => {
    const opId = "op_fresh_proc";
    worker.appendCanonicalEvent(opId, "turn_started");           // seq 0
    worker.appendCanonicalEvent(opId, "turn_committed");         // seq 1

    // control-api process has NEVER emitted for this op — its cache is empty,
    // so it must read the two existing events off disk and continue at seq 2,
    // not restart at 0.
    const ev = controlApi.appendCanonicalEvent(opId, "cancel_requested");
    expect(ev.seq).toBe(2);
  });
});

describe("appendCanonicalEvent — hot path avoids the full-file rescan (CL-9)", () => {
  it("does not readFileSync the canonical log on every emit once warm", () => {
    const opId = "op_hot_path";

    // First emit re-seeds from disk (log is empty ⇒ no file yet ⇒ 0 reads),
    // subsequent emits populate the cache. Warm it, then reset the counter.
    for (let i = 0; i < 5; i++) worker.appendCanonicalEvent(opId, "message_appended");
    h.canonReads = 0;

    // A burst of emits from the warm single writer must not re-read the log.
    for (let i = 0; i < 50; i++) worker.appendCanonicalEvent(opId, "message_appended");
    expect(h.canonReads).toBe(0);

    // And it stayed correct: 55 monotonic seqs, no gaps.
    const seqs = worker.readCanonicalEvents(opId).map((e: CanonicalEvent) => e.seq);
    expect(seqs.length).toBe(55);
    for (let i = 0; i < seqs.length; i++) expect(seqs[i]).toBe(i);
  });
});
