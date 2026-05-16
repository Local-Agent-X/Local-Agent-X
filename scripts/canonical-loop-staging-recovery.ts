/**
 * Staging exercise: canonical-loop worker-death + crash recovery.
 *
 * Submits a real op through the canonical seam, lets it commit turn 0,
 * pauses the worker's heartbeat to simulate process death, waits for the
 * lease to expire, calls recoverStaleOp, lets the replacement worker
 * complete, then prints the audit trail required by PRD §22 operational
 * gates.
 *
 * Run: npx tsx scripts/canonical-loop-staging-recovery.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  canonicalLoopEntry,
  registerAdapterForOp,
  setLeaseConfig,
  awaitIdle,
  readCanonicalEvents,
  readLatestOpTurn,
  readOpTurn,
  recoverStaleOp,
  _pauseHeartbeat,
} from "../src/canonical-loop/index.js";
import { readOp, newOpId } from "../src/ops/op-store.js";
import { FakeAdapter, scriptTurn, scriptLongStreamingTurn } from "../test/canonical-loop/fake-adapter.js";
import type { Op } from "../src/ops/types.js";

const OPS_BASE = join(homedir(), ".lax", "operations");

function readOperationJson(opId: string): unknown {
  const p = join(OPS_BASE, opId, "operation.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8"));
}

async function sleep(ms: number): Promise<void> {
  await new Promise(r => setTimeout(r, ms));
}

async function awaitFirstCommit(opId: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readLatestOpTurn(opId)?.turnIdx === 0) return;
    await sleep(5);
  }
  throw new Error(`turn 0 never committed for ${opId}`);
}

async function awaitTerminal(opId: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = readOp(opId)?.canonical?.state;
    if (s === "succeeded" || s === "failed" || s === "cancelled") return;
    await sleep(5);
  }
  throw new Error(`op ${opId} did not terminate`);
}

async function main(): Promise<void> {
  process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "1";
  // Compress lease so the exercise finishes in seconds instead of 30+.
  setLeaseConfig({ leaseDurationMs: 250, heartbeatIntervalMs: 60 });

  const op: Op = {
    id: newOpId("staging_recovery"),
    type: "freeform",
    task: "staging worker-death recovery",
    contextPack: {} as Op["contextPack"],
    lane: "interactive",
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5000] },
    ownerId: "staging-exercise",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };

  // First adapter: emit turn 0 (no terminal). Worker A will commit it
  // and then "die" before turn 1 starts.
  // Replacement adapter (factory call #2): emit turn 1 with terminal=done.
  let factoryCalls = 0;
  registerAdapterForOp(op.id, () => {
    factoryCalls++;
    if (factoryCalls === 1) {
      return new FakeAdapter({
        script: [
          // Turn 0: instant commit.
          scriptTurn({ text: "turn 0 from worker A", terminal: undefined }),
          // Turn 1: long-streaming so we can pause heartbeat mid-turn.
          // 200 chunks * 25ms = 5s total — plenty of window to crash A.
          scriptLongStreamingTurn({ chunkIntervalMs: 25, maxChunks: 200 }),
        ],
      });
    }
    return new FakeAdapter({
      script: [scriptTurn({ text: "turn 1 from worker B (recovered)", terminal: "done" })],
    });
  });

  console.log(`opId: ${op.id}`);
  console.log("─".repeat(72));

  canonicalLoopEntry(op);

  // Wait for turn 0 to commit AND turn 1 to start streaming, so worker A
  // is mid-turn when we kill its heartbeat.
  const diagDeadline = Date.now() + 3000;
  let turn1Started = false;
  while (Date.now() < diagDeadline) {
    const evs = readCanonicalEvents(op.id);
    turn1Started = evs.some(e => e.type === "turn_started" && (e.body as { turnIdx?: number }).turnIdx === 1);
    if (readLatestOpTurn(op.id)?.turnIdx === 0 && turn1Started) break;
    await sleep(10);
  }
  if (!turn1Started) {
    console.log("DIAG: worker A never started turn 1");
    process.exit(3);
  }

  // Snapshot BEFORE recovery.
  const beforeOp = readOperationJson(op.id) as Record<string, unknown>;
  console.log("\n=== operation.json BEFORE recovery ===");
  console.log(JSON.stringify((beforeOp as { canonical?: unknown }).canonical, null, 2));

  // Pause Worker A's heartbeat. The lease will expire on its own.
  const eventsBefore = readCanonicalEvents(op.id);
  const leaseAcq = eventsBefore.find(e => e.type === "lease_acquired");
  const workerA = (leaseAcq?.body as { workerId?: string })?.workerId;
  if (!workerA) throw new Error("no lease_acquired event found");
  console.log(`\n>>> simulating worker death — pausing heartbeat for workerA=${workerA}`);
  const paused = _pauseHeartbeat(workerA);
  console.log(`    _pauseHeartbeat returned ${paused}`);

  // Wait for lease to expire (250ms + buffer).
  await sleep(400);

  // Recover.
  console.log("\n>>> calling recoverStaleOp");
  const outcome = recoverStaleOp(op.id);
  console.log(`    outcome: ${JSON.stringify(outcome)}`);

  // Replacement worker leases. Wait for terminal.
  await awaitTerminal(op.id);
  await awaitIdle(2000).catch(() => undefined);

  // Snapshot AFTER recovery.
  const afterOp = readOperationJson(op.id) as Record<string, unknown>;
  console.log("\n=== operation.json AFTER recovery ===");
  console.log(JSON.stringify((afterOp as { canonical?: unknown }).canonical, null, 2));

  // canonical-events.jsonl audit trail.
  const events = readCanonicalEvents(op.id);
  console.log("\n=== canonical-events.jsonl ===");
  for (const e of events) {
    console.log(`seq=${String(e.seq).padStart(2, " ")}  ${e.type.padEnd(20)} ${JSON.stringify(e.body)}`);
  }

  // Filter for the recovery-relevant events.
  console.log("\n=== lease_lost / lease_acquired / state_changed events only ===");
  const relevant = events.filter(e =>
    e.type === "lease_acquired" || e.type === "lease_lost" || e.type === "state_changed",
  );
  for (const e of relevant) {
    console.log(`seq=${String(e.seq).padStart(2, " ")}  ${e.type.padEnd(20)} ${JSON.stringify(e.body)}`);
  }

  // op_turns count + final state.
  const finalState = (afterOp as { canonical?: { state?: string } }).canonical?.state;
  let turnCount = 0;
  for (let i = 0; i < 10; i++) {
    if (readOpTurn(op.id, i)) turnCount = i + 1;
    else break;
  }

  console.log("\n=== summary ===");
  console.log(`opId:         ${op.id}`);
  console.log(`final state:  ${finalState}`);
  console.log(`op_turns:     ${turnCount}`);
  console.log(`workerIds:    ${[...new Set(events.filter(e => e.type === "lease_acquired").map(e => (e.body as { workerId: string }).workerId))].join(", ")}`);
  console.log(`factoryCalls: ${factoryCalls}`);

  // Hard assertions on the invariants the PRD cares about.
  const assertions = [
    ["final state === succeeded", finalState === "succeeded"],
    ["op_turns count === 2 (no duplicate commits)", turnCount === 2],
    ["lease_lost reason='expired' present", events.some(e => e.type === "lease_lost" && (e.body as { reason?: string }).reason === "expired")],
    ["≥2 distinct workerIds in lease_acquired", new Set(events.filter(e => e.type === "lease_acquired").map(e => (e.body as { workerId: string }).workerId)).size >= 2],
    ["state_changed running→queued (lease_expired) present", events.some(e => e.type === "state_changed" && (e.body as { from?: string; to?: string; reason?: string }).from === "running" && (e.body as { to: string }).to === "queued" && (e.body as { reason: string }).reason === "lease_expired")],
    ["exactly one terminal state_changed (running→succeeded)", events.filter(e => e.type === "state_changed" && (e.body as { to: string }).to === "succeeded").length === 1],
    ["per-op seq monotonic 0..N", events.every((e, i) => e.seq === i)],
  ] as const;
  console.log("\n=== invariants ===");
  let allPass = true;
  for (const [name, ok] of assertions) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) allPass = false;
  }
  console.log(allPass ? "\nALL INVARIANTS PASS" : "\nSOME INVARIANTS FAILED");
  process.exit(allPass ? 0 : 1);
}

main().catch(e => {
  console.error("staging exercise failed:", e);
  process.exit(2);
});
